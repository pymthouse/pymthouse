/**
 * RFC 8693 token exchange: bind a pending RFC 8628 device code using a PymtHouse-issued
 * user access_token as subject_token and resource=urn:pmth:device_code:<user_code>.
 *
 * Confidential (M2M) client authenticates; subject_token must have been issued to the
 * same app's public client_id.
 */

import { eq } from "drizzle-orm";
import { hasScope } from "@/domains/identity-access/runtime/request-auth";
import { normalizeUserCode } from "@/platform/oidc/device";
import { verifyAccessToken } from "@/domains/oidc-platform/runtime/access-token-verify";
import { getIssuer } from "@/platform/oidc/issuer-urls";
import { TokenExchangeError } from "@/domains/oidc-platform/runtime/token-exchange";
import { findOrCreateAppEndUser } from "@/domains/end-user-accounts/runtime/end-users";
import {
  createCorrelationId,
  writeAuditLog,
} from "@/domains/identity-access/runtime/audit";
import {
  resolvePublicClientIdForOidcRow,
  DeveloperAppSiblingAmbiguousError,
  type DrizzleDb,
} from "@/platform/oidc/client-sibling";
import { db as defaultDbConn } from "../repo/db-conn";
import {
  getAppUserExternalUserId,
  getConfidentialOidcClientByClientId,
  getDeveloperAppIdByOidcClientRowId,
  getPublicOidcClientDevicePolicy,
} from "../repo/token-exchange-flows";
import { validateClientSecret } from "./clients";
import { approveDeviceCodeForAccount } from "./device-approval";

export type { DrizzleDb };

export type DeviceApprovalTokenExchangeDeps = {
  validateClientSecret: typeof validateClientSecret;
  verifyAccessToken: typeof verifyAccessToken;
  approveDeviceCodeForAccount: typeof approveDeviceCodeForAccount;
  findOrCreateAppEndUser: typeof findOrCreateAppEndUser;
  db: DrizzleDb;
  writeAuditLog: typeof writeAuditLog;
  createCorrelationId: typeof createCorrelationId;
};

const defaultDeviceApprovalDeps: DeviceApprovalTokenExchangeDeps = {
  validateClientSecret,
  verifyAccessToken,
  approveDeviceCodeForAccount,
  findOrCreateAppEndUser,
  db: defaultDbConn,
  writeAuditLog,
  createCorrelationId,
};

const TOKEN_EXCHANGE_GRANT = "urn:ietf:params:oauth:grant-type:token-exchange";
const SUBJECT_ACCESS_TOKEN_TYPE = "urn:ietf:params:oauth:token-type:access_token";
const ISSUED_ACCESS_TOKEN_TYPE = "urn:ietf:params:oauth:token-type:access_token";
const DEVICE_CODE_RESOURCE_PREFIX = "urn:pmth:device_code:";

export function isDeviceApprovalTokenExchangeRequest(params: {
  grantType: string;
  subjectTokenType: string;
  resource: string | null | undefined;
}): boolean {
  const resource = params.resource?.trim() ?? "";
  return (
    params.grantType === TOKEN_EXCHANGE_GRANT &&
    params.subjectTokenType === SUBJECT_ACCESS_TOKEN_TYPE &&
    resource.startsWith(DEVICE_CODE_RESOURCE_PREFIX)
  );
}

function parseDeviceCodeFromResource(resource: string): string | null {
  const rest = resource.slice(DEVICE_CODE_RESOURCE_PREFIX.length).trim();
  if (!rest) return null;
  return rest;
}

function normalizeResourceOrAudienceUri(value: string): string {
  return value.trim().replace(/\/+$/, "");
}

function assertRequestedTokenTypeForDeviceApproval(
  requested: string | null | undefined,
): void {
  if (requested == null || requested.trim() === "") return;
  if (requested.trim() === ISSUED_ACCESS_TOKEN_TYPE) return;
  throw new TokenExchangeError(
    "invalid_request",
    `requested_token_type must be ${ISSUED_ACCESS_TOKEN_TYPE} or omitted`,
    "The requested token type is not supported for this token exchange",
  );
}

function assertDeviceApprovalAudiences(audiences: string[]): void {
  const nonEmpty = audiences.map((a) => a.trim()).filter(Boolean);
  if (nonEmpty.length === 0) return;
  const issuer = normalizeResourceOrAudienceUri(getIssuer());
  for (const raw of nonEmpty) {
    if (normalizeResourceOrAudienceUri(raw) !== issuer) {
      throw new TokenExchangeError(
        "invalid_target",
        "audience does not match this authorization server",
        "Invalid audience for token exchange",
      );
    }
  }
}

function scopeStringFromAccessPayload(payload: Record<string, unknown>): string {
  const scopeFromScope = typeof payload.scope === "string" ? payload.scope.trim() : "";
  if (scopeFromScope) return scopeFromScope.replace(/\s+/g, " ").trim();
  const scpRaw = payload.scp;
  if (Array.isArray(scpRaw)) {
    return scpRaw.filter((v): v is string => typeof v === "string").join(" ");
  }
  if (typeof scpRaw === "string") return scpRaw.trim();
  return "sign:job";
}

function expiresInFromPayload(payload: Record<string, unknown>): number {
  const exp = payload.exp;
  if (typeof exp !== "number") return 15 * 60;
  const now = Math.floor(Date.now() / 1000);
  return Math.max(1, exp - now);
}

export async function handleDeviceApprovalTokenExchange(
  params: {
    clientId: string;
    clientSecret: string;
    subjectToken: string;
    subjectTokenType: string;
    resource: string | null | undefined;
    requestedTokenType?: string | null;
    audience?: string[];
  },
  deps: Partial<DeviceApprovalTokenExchangeDeps> = {},
): Promise<{
  access_token: string;
  token_type: "Bearer";
  expires_in: number;
  scope: string;
  issued_token_type: string;
}> {
  const {
    validateClientSecret: validateSecret,
    verifyAccessToken: verifySubject,
    approveDeviceCodeForAccount: approveDevice,
    findOrCreateAppEndUser: resolveEndUser,
    db: dbConn,
    writeAuditLog: auditLog,
    createCorrelationId: newCorrelationId,
  } = { ...defaultDeviceApprovalDeps, ...deps };

  const {
    clientId,
    clientSecret,
    subjectToken,
    subjectTokenType,
    resource,
    requestedTokenType,
    audience: audienceParams,
  } = params;

  if (!(await validateSecret(clientId, clientSecret))) {
    throw new TokenExchangeError("invalid_client", "Invalid client credentials", "Invalid client credentials");
  }

  if (subjectTokenType.trim() !== SUBJECT_ACCESS_TOKEN_TYPE) {
    throw new TokenExchangeError(
      "invalid_request",
      `subject_token_type must be ${SUBJECT_ACCESS_TOKEN_TYPE}`,
      "Invalid subject_token_type for device approval token exchange",
    );
  }

  const m2mRow = await getConfidentialOidcClientByClientId(dbConn, clientId);
  if (!m2mRow?.clientSecretHash) {
    throw new TokenExchangeError("invalid_client", "Client not found or not confidential", "Invalid client credentials");
  }

  if (
    !hasScope(m2mRow.allowedScopes, "device:approve") &&
    !hasScope(m2mRow.allowedScopes, "users:token")
  ) {
    throw new TokenExchangeError(
      "invalid_scope",
      "Requires device:approve or users:token on the confidential client",
      "Missing required scope for device approval token exchange",
    );
  }

  assertRequestedTokenTypeForDeviceApproval(requestedTokenType);

  const resourceStr = resource?.trim() ?? "";
  if (!resourceStr.startsWith(DEVICE_CODE_RESOURCE_PREFIX)) {
    throw new TokenExchangeError(
      "invalid_target",
      `resource must start with ${DEVICE_CODE_RESOURCE_PREFIX}`,
      "Invalid resource for device approval",
    );
  }

  const userCodeRaw = parseDeviceCodeFromResource(resourceStr);
  if (!userCodeRaw) {
    throw new TokenExchangeError(
      "invalid_target",
      "device user_code missing from resource",
      "Invalid resource for device approval",
    );
  }
  const normalizedUserCode = normalizeUserCode(userCodeRaw);

  assertDeviceApprovalAudiences(audienceParams ?? []);

  let publicClientId: string | null;
  try {
    publicClientId = await resolvePublicClientIdForOidcRow(dbConn, m2mRow.id);
  } catch (err) {
    if (err instanceof DeveloperAppSiblingAmbiguousError) {
      console.error("[device-token-exchange] ambiguous developer app mapping", {
        message: err.message,
        conflictingDeveloperAppIds: err.conflictingDeveloperAppIds,
      });
      throw new TokenExchangeError(
        "invalid_request",
        "Ambiguous developer app mapping for this client",
        "Multiple developer apps found for this client",
      );
    }
    throw err;
  }
  if (!publicClientId) {
    throw new TokenExchangeError("invalid_client", "No developer app linked to this client", "Invalid client credentials");
  }

  const payload = await verifySubject(subjectToken);
  if (!payload || typeof payload.sub !== "string" || !payload.sub) {
    throw new TokenExchangeError(
      "invalid_grant",
      "subject_token is not a valid access token for this issuer",
      "Invalid subject token",
    );
  }

  const rec = payload as Record<string, unknown>;
  const tokenClientId =
    typeof rec.client_id === "string"
      ? rec.client_id
      : typeof rec.azp === "string"
        ? rec.azp
        : null;
  if (!tokenClientId || tokenClientId !== publicClientId) {
    throw new TokenExchangeError(
      "invalid_grant",
      "subject_token must have been issued to this app's public client_id",
      "Invalid subject token",
    );
  }

  const publicOidc = await getPublicOidcClientDevicePolicy(dbConn, publicClientId);
  if (!publicOidc) {
    throw new TokenExchangeError("invalid_client", "Public client not found", "Public client not found");
  }
  if (publicOidc.deviceThirdPartyInitiateLogin !== 1) {
    throw new TokenExchangeError(
      "invalid_client",
      "Device third-party login is not enabled for this client",
      "Device third-party login is not enabled for this client",
    );
  }

  const developerAppId = await getDeveloperAppIdByOidcClientRowId(dbConn, publicOidc.id);
  if (!developerAppId) {
    throw new TokenExchangeError("invalid_client", "Developer app not found", "Developer app not found");
  }

  const externalUserId = await getAppUserExternalUserId(dbConn, payload.sub);
  if (!externalUserId) {
    throw new TokenExchangeError(
      "invalid_grant",
      "subject_token sub does not map to an app user",
      "Invalid subject token",
    );
  }
  const { id: accountId } = await resolveEndUser(developerAppId, externalUserId);

  const approve = await approveDevice(normalizedUserCode, publicClientId, accountId);
  if (!approve.ok) {
    throw new TokenExchangeError(approve.error, approve.description, approve.description);
  }

  const correlationId = newCorrelationId();
  await auditLog({
    clientId: developerAppId,
    actorUserId: null,
    action: "device_code_approved_token_exchange",
    status: "success",
    correlationId,
    metadata: {
      oidcClientId: publicClientId,
      m2mClientId: clientId,
    },
  });

  return {
    access_token: subjectToken,
    token_type: "Bearer",
    expires_in: expiresInFromPayload(rec),
    scope: scopeStringFromAccessPayload(rec),
    issued_token_type: ISSUED_ACCESS_TOKEN_TYPE,
  };
}
