import { and, eq } from "drizzle-orm";
import { db } from "@/db/index";
import { appUsers, endUsers, oidcClients } from "@/db/schema";
import { billingPatternFromAllowedScopesString } from "@/lib/allowed-scopes";
import { findOrCreateAppEndUser } from "@/lib/billing";
import { createCorrelationId, writeAuditLog } from "@/lib/audit";
import { createSession, hasScope } from "@/lib/auth";
import { validateClientSecret } from "./clients";
import {
  resolveDeveloperAppAndPublicClientForOidcRow,
  DeveloperAppSiblingAmbiguousError,
  type DrizzleDb,
} from "@/lib/oidc/client-sibling";
import { verifyAccessToken } from "./access-token-verify";
import { getIssuer } from "./issuer-urls";
import { TokenExchangeError } from "./token-exchange";

export type GatewayTokenExchangeDeps = {
  validateClientSecret: typeof validateClientSecret;
  verifyAccessToken: typeof verifyAccessToken;
  db: DrizzleDb;
  findOrCreateAppEndUser: typeof findOrCreateAppEndUser;
  createSession: typeof createSession;
  writeAuditLog: typeof writeAuditLog;
  createCorrelationId: typeof createCorrelationId;
  resolveDeveloperAppAndPublicClientForOidcRow: typeof resolveDeveloperAppAndPublicClientForOidcRow;
};

const defaultGatewayDeps: GatewayTokenExchangeDeps = {
  validateClientSecret,
  verifyAccessToken,
  db,
  findOrCreateAppEndUser,
  createSession,
  writeAuditLog,
  createCorrelationId,
  resolveDeveloperAppAndPublicClientForOidcRow,
};

/** RFC 8693: access token as subject token */
export const SUBJECT_ACCESS_TOKEN_TYPE =
  "urn:ietf:params:oauth:token-type:access_token";

/** RFC 8693: issued token is an access token (opaque remote signer session) */
export const ISSUED_ACCESS_TOKEN_TYPE =
  "urn:ietf:params:oauth:token-type:access_token";

function normalizeResourceOrAudienceUri(value: string): string {
  return value.trim().replace(/\/+$/, "");
}

function assertRequestedTokenTypeForGateway(
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

function assertGatewayAudiences(audiences: string[] | undefined): void {
  const nonEmpty = (audiences ?? []).map((a) => a.trim()).filter(Boolean);
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

function assertGatewayResource(resource: string | null | undefined): void {
  const raw = resource?.trim() ?? "";
  if (raw === "") return;
  const issuer = normalizeResourceOrAudienceUri(getIssuer());
  if (normalizeResourceOrAudienceUri(raw) === issuer) return;
  throw new TokenExchangeError(
    "invalid_target",
    "resource must be omitted or name this authorization server",
    "Invalid resource for remote signer session exchange",
  );
}

/**
 * Remote signer session exchange: OIDC access token (JWT from this issuer) -> long-lived `pmth_*`
 * session, via RFC 8693 at POST /api/v1/oidc/token.
 *
 * Confidential client authenticates with HTTP Basic; `subject_token` must have been issued to
 * this app's public `app_…` client or (legacy) to the same M2M `client_id` as this request.
 * The caller must have `users:token` and per-user billing (`users:token` on allowed_scopes).
 */
export async function handleGatewayTokenExchange(
  params: {
    clientId: string;
    clientSecret: string;
    subjectToken: string;
    subjectTokenType: string;
    resource?: string | null;
    requestedTokenType?: string | null;
    audience?: string[];
  },
  inject: Partial<GatewayTokenExchangeDeps> = {},
): Promise<{
  access_token: string;
  token_type: "Bearer";
  expires_in: number;
  issued_token_type: string;
  scope: string;
}> {
  const deps: GatewayTokenExchangeDeps = { ...defaultGatewayDeps, ...inject };
  const dbConn = deps.db;

  const {
    clientId,
    clientSecret,
    subjectToken,
    subjectTokenType,
    resource,
    requestedTokenType,
    audience: audienceParams,
  } = params;

  if (subjectTokenType.trim() !== SUBJECT_ACCESS_TOKEN_TYPE) {
    throw new TokenExchangeError(
      "unsupported_token_type",
      `For remote signer session exchange, subject_token_type must be ${SUBJECT_ACCESS_TOKEN_TYPE}`,
    );
  }

  if (!(await deps.validateClientSecret(clientId, clientSecret))) {
    throw new TokenExchangeError("invalid_client", "Invalid client credentials");
  }

  const clientRows = await dbConn
    .select()
    .from(oidcClients)
    .where(eq(oidcClients.clientId, clientId))
    .limit(1);
  const callerRow = clientRows[0];
  if (!callerRow?.clientSecretHash) {
    throw new TokenExchangeError(
      "invalid_client",
      "Client not found or not confidential",
    );
  }

  if (!hasScope(callerRow.allowedScopes, "users:token")) {
    throw new TokenExchangeError(
      "invalid_scope",
      "Requires users:token on the confidential client",
    );
  }

  if (
    billingPatternFromAllowedScopesString(callerRow.allowedScopes) !== "per_user"
  ) {
    throw new TokenExchangeError(
      "invalid_request",
      "Remote signer session exchange requires per-user billing (users:token scope on the OAuth client)",
    );
  }

  assertRequestedTokenTypeForGateway(requestedTokenType);
  assertGatewayAudiences(audienceParams);
  assertGatewayResource(resource);

  let sibling: { developerAppId: string; publicClientId: string } | null;
  try {
    sibling = await deps.resolveDeveloperAppAndPublicClientForOidcRow(
      dbConn,
      callerRow.id,
    );
  } catch (err) {
    if (err instanceof DeveloperAppSiblingAmbiguousError) {
      console.error("[gateway-token-exchange] ambiguous developer app mapping", {
        message: err.message,
        conflictingDeveloperAppIds: err.conflictingDeveloperAppIds,
      });
      throw new TokenExchangeError(
        "invalid_request",
        err.message,
        "Ambiguous developer app mapping for this client",
      );
    }
    throw err;
  }
  if (!sibling) {
    throw new TokenExchangeError(
      "invalid_client",
      "No developer app linked to this client",
    );
  }

  const { publicClientId, developerAppId } = sibling;

  const payload = await deps.verifyAccessToken(subjectToken);
  if (!payload || typeof payload.sub !== "string" || !payload.sub) {
    throw new TokenExchangeError(
      "invalid_grant",
      "subject_token is not a valid OIDC access token for this issuer",
    );
  }

  const rec = payload as Record<string, unknown>;
  const tokenClientId =
    typeof rec.client_id === "string"
      ? rec.client_id
      : typeof rec.azp === "string"
        ? rec.azp
        : null;
  if (!tokenClientId) {
    throw new TokenExchangeError(
      "invalid_grant",
      "subject_token must include client_id or azp",
    );
  }

  const callerIsM2M = clientId !== publicClientId;
  const subjectMatchesCaller = tokenClientId === clientId;
  const subjectMatchesPublicSibling = tokenClientId === publicClientId;
  if (!subjectMatchesCaller && !(callerIsM2M && subjectMatchesPublicSibling)) {
    throw new TokenExchangeError(
      "invalid_grant",
      "subject_token must have been issued to this app's public client or to the same confidential client as this request",
    );
  }

  const scopeFromScope =
    typeof payload.scope === "string" ? payload.scope : "";
  const scpRaw = (payload as Record<string, unknown>).scp;
  const scopeFromScp = Array.isArray(scpRaw)
    ? scpRaw.filter((v): v is string => typeof v === "string").join(" ")
    : typeof scpRaw === "string"
      ? scpRaw
      : "";
  const normalizedScopes = (scopeFromScope || scopeFromScp)
    .trim()
    .replace(/\s+/g, ",");
  const effectiveScopes = normalizedScopes;

  if (!hasScope(effectiveScopes, "sign:job")) {
    throw new TokenExchangeError(
      "invalid_grant",
      "subject_token must include sign:job scope for remote signer session exchange",
    );
  }

  const sessionBinding = await resolveGatewaySessionPrincipal(
    {
      dbConn,
      developerAppId,
      sub: payload.sub,
      tokenClientId,
      clientId,
    },
    deps,
  );

  const { token } = await deps.createSession({
    userId: sessionBinding.userId,
    endUserId: sessionBinding.endUserId,
    appId: publicClientId,
    scopes: "sign:job",
    label: "signer_session_token_exchange",
    expiresInDays: 90,
  });

  const correlationId = deps.createCorrelationId();
  await deps.writeAuditLog({
    clientId: developerAppId,
    action: "signer_session_token_exchange",
    status: "success",
    correlationId,
    metadata: {
      oidcClientId: publicClientId,
      m2mClientId: clientId,
      endUserId: sessionBinding.endUserId,
    },
  });

  const expiresIn = 90 * 24 * 60 * 60;

  return {
    access_token: token,
    token_type: "Bearer",
    expires_in: expiresIn,
    issued_token_type: ISSUED_ACCESS_TOKEN_TYPE,
    scope: "sign:job",
  };
}

async function resolveGatewaySessionPrincipal(
  input: {
    dbConn: DrizzleDb;
    developerAppId: string;
    sub: string;
    tokenClientId: string;
    clientId: string;
  },
  deps: Pick<GatewayTokenExchangeDeps, "findOrCreateAppEndUser">,
): Promise<{ userId: string | undefined; endUserId: string | undefined }> {
  const { dbConn, developerAppId, sub, tokenClientId, clientId } = input;

  const appUserRows = await dbConn
    .select({ externalUserId: appUsers.externalUserId })
    .from(appUsers)
    .where(and(eq(appUsers.clientId, developerAppId), eq(appUsers.id, sub)))
    .limit(1);
  const externalUserId = appUserRows[0]?.externalUserId;
  if (externalUserId) {
    const { id: endUserId } = await deps.findOrCreateAppEndUser(
      developerAppId,
      externalUserId,
    );
    return { userId: undefined, endUserId };
  }

  const endUserDirect = await dbConn
    .select({ id: endUsers.id })
    .from(endUsers)
    .where(and(eq(endUsers.id, sub), eq(endUsers.appId, developerAppId)))
    .limit(1);
  if (endUserDirect[0]) {
    return { userId: undefined, endUserId: endUserDirect[0].id };
  }

  if (tokenClientId === clientId) {
    return { userId: sub, endUserId: undefined };
  }

  throw new TokenExchangeError(
    "invalid_grant",
    "subject_token sub does not map to an app user or end user for this developer app",
  );
}

export function isGatewayTokenExchangeRequest(params: {
  grantType: string;
  clientId: string;
  subjectTokenType: string;
  resource: string | null | undefined;
}): boolean {
  const resource = params.resource?.trim() ?? "";
  if (resource.startsWith("urn:pmth:device_code:")) {
    return false;
  }
  return (
    params.grantType ===
      "urn:ietf:params:oauth:grant-type:token-exchange" &&
    Boolean(params.clientId) &&
    params.subjectTokenType.trim() === SUBJECT_ACCESS_TOKEN_TYPE
  );
}
