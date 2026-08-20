import { and, eq } from "drizzle-orm";
import { db } from "@/db/index";
import { appUsers, developerApps, endUsers, oidcClients, users } from "@/db/schema";
import { findOrCreateAppEndUser } from "@/lib/billing";
import { MCP_OAUTH_APP_CLAIM, getMcpResourceUrl } from "@/lib/mcp/oauth-resource";
import { verifyAccessToken } from "@/lib/oidc/access-token-verify";
import { TokenExchangeError } from "@/lib/oidc/token-exchange";

export class SubjectAccessTokenResolveError extends Error {
  code: string;
  status: number;

  constructor(
    code: string,
    message: string,
    status = 400,
  ) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

export interface ResolvedSubjectAccessToken {
  payload: Record<string, unknown>;
  sub: string;
  publicClientId: string;
  developerAppId: string;
  externalUserId: string;
}

function readTokenClientId(payload: Record<string, unknown>): string | null {
  const clientId = payload.client_id;
  if (typeof clientId === "string" && clientId.trim()) {
    return clientId.trim();
  }
  const azp = payload.azp;
  if (typeof azp === "string" && azp.trim()) {
    return azp.trim();
  }
  return null;
}

/**
 * MCP OAuth tokens bind the Builder app via `pymthouse_app` (public `app_…`
 * client id), not via the DCR `client_id` / `azp`.
 */
function readMcpBoundPublicClientId(payload: Record<string, unknown>): string | null {
  const bound = payload[MCP_OAUTH_APP_CLAIM];
  if (typeof bound === "string" && bound.trim()) {
    return bound.trim();
  }
  return null;
}

async function resolveDeveloperAppFromPublicClient(
  dbConn: typeof db,
  publicClientId: string,
): Promise<{ appId: string; ownerId: string } | null> {
  const rows = await dbConn
    .select({
      appId: developerApps.id,
      ownerId: developerApps.ownerId,
    })
    .from(developerApps)
    .innerJoin(oidcClients, eq(developerApps.oidcClientId, oidcClients.id))
    .where(eq(oidcClients.clientId, publicClientId))
    .limit(1);
  return rows[0] ?? null;
}

async function resolveIdentityFromAccessPayload(
  rec: Record<string, unknown>,
  publicClientId: string,
  options?: {
    expectedPublicClientId?: string | null;
    dbConn?: typeof db;
  },
): Promise<ResolvedSubjectAccessToken> {
  const dbConn = options?.dbConn ?? db;
  const sub = typeof rec.sub === "string" ? rec.sub.trim() : "";
  if (!sub) {
    throw new SubjectAccessTokenResolveError(
      "invalid_grant",
      "subject_token is not a valid access token for this issuer",
      400,
    );
  }

  if (
    options?.expectedPublicClientId &&
    options.expectedPublicClientId !== publicClientId
  ) {
    throw new SubjectAccessTokenResolveError(
      "invalid_grant",
      "subject_token must have been issued for the expected public client_id",
      400,
    );
  }

  const developerApp = await resolveDeveloperAppFromPublicClient(
    dbConn,
    publicClientId,
  );
  if (!developerApp) {
    throw new SubjectAccessTokenResolveError(
      "invalid_grant",
      "subject_token does not map to a developer app",
      400,
    );
  }

  const appUserRows = await dbConn
    .select({
      externalUserId: appUsers.externalUserId,
      developerAppId: appUsers.clientId,
    })
    .from(appUsers)
    .where(and(eq(appUsers.id, sub), eq(appUsers.clientId, developerApp.appId)))
    .limit(1);
  const appUser = appUserRows[0];
  if (appUser?.externalUserId) {
    return {
      payload: rec,
      sub,
      publicClientId,
      developerAppId: appUser.developerAppId,
      externalUserId: appUser.externalUserId,
    };
  }

  const endUserRows = await dbConn
    .select({ externalUserId: endUsers.externalUserId })
    .from(endUsers)
    .where(and(eq(endUsers.id, sub), eq(endUsers.appId, developerApp.appId)))
    .limit(1);
  const endUser = endUserRows[0];
  if (endUser?.externalUserId) {
    return {
      payload: rec,
      sub,
      publicClientId,
      developerAppId: developerApp.appId,
      externalUserId: endUser.externalUserId,
    };
  }

  const platformUserRows = await dbConn
    .select({ id: users.id })
    .from(users)
    .where(eq(users.id, sub))
    .limit(1);
  if (platformUserRows[0]) {
    const externalUserId = `user:${sub}`;
    await findOrCreateAppEndUser(developerApp.appId, externalUserId);
    return {
      payload: rec,
      sub,
      publicClientId,
      developerAppId: developerApp.appId,
      externalUserId,
    };
  }

  throw new SubjectAccessTokenResolveError(
    "invalid_grant",
    "subject_token sub does not map to an app user, end user, or app owner",
    400,
  );
}

/**
 * Resolve a PymtHouse-issued user access JWT (`aud=issuer`) to developer app
 * context. MCP resource tokens must use {@link resolveMcpAccessToken}.
 */
export async function resolveSubjectAccessToken(
  subjectToken: string,
  options?: {
    expectedPublicClientId?: string | null;
    dbConn?: typeof db;
  },
): Promise<ResolvedSubjectAccessToken> {
  const payload = await verifyAccessToken(subjectToken);
  if (!payload || typeof payload.sub !== "string" || !payload.sub.trim()) {
    throw new SubjectAccessTokenResolveError(
      "invalid_grant",
      "subject_token is not a valid access token for this issuer",
      400,
    );
  }

  const rec = payload as Record<string, unknown>;
  const publicClientId = readTokenClientId(rec);
  if (!publicClientId) {
    throw new SubjectAccessTokenResolveError(
      "invalid_grant",
      "subject_token must include client_id or azp",
      400,
    );
  }

  return resolveIdentityFromAccessPayload(rec, publicClientId, options);
}

/**
 * Resolve an MCP OAuth access token (`aud=MCP resource`). Never accepted as a
 * general RFC 8693 subject token — audience stays bound to `/api/v1/mcp`.
 */
export async function resolveMcpAccessToken(
  accessToken: string,
  options?: {
    expectedPublicClientId?: string | null;
    dbConn?: typeof db;
  },
): Promise<ResolvedSubjectAccessToken> {
  const payload = await verifyAccessToken(accessToken, {
    audience: getMcpResourceUrl(),
  });
  if (!payload || typeof payload.sub !== "string" || !payload.sub.trim()) {
    throw new SubjectAccessTokenResolveError(
      "invalid_grant",
      "access token is not a valid MCP resource token for this issuer",
      400,
    );
  }

  const rec = payload as Record<string, unknown>;
  const publicClientId = readMcpBoundPublicClientId(rec);
  if (!publicClientId) {
    throw new SubjectAccessTokenResolveError(
      "invalid_grant",
      "MCP access token must include pymthouse_app",
      400,
    );
  }

  return resolveIdentityFromAccessPayload(rec, publicClientId, options);
}

export function subjectAccessTokenResolveErrorToTokenExchange(
  err: SubjectAccessTokenResolveError,
): TokenExchangeError {
  return new TokenExchangeError(err.code, err.message, err.message);
}
