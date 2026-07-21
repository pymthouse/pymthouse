import { and, eq } from "drizzle-orm";

import { splitCompositeApiKey } from "@/lib/app-api-keys";
import { db } from "@/db/index";
import { appUsers, developerApps, oidcClients } from "@/db/schema";
import { verifyAccessToken } from "@/lib/oidc/access-token-verify";
import {
  resolveSubjectAccessToken,
  SubjectAccessTokenResolveError,
} from "@/lib/oidc/resolve-subject-access-token";

export type EndUserAuth = {
  publicClientId: string;
  developerAppId: string;
  externalUserId: string;
};

/**
 * Reject client-supplied subject overrides on `/api/v1/user/*` routes.
 * Subject is always taken from the Bearer credential.
 */
export function endUserSubjectOverrideError(
  searchParams: URLSearchParams,
  resourceLabel: string,
): Response | null {
  if (
    searchParams.has("externalUserId") ||
    searchParams.has("external_user_id") ||
    searchParams.has("userId")
  ) {
    return Response.json(
      {
        error: `userId/externalUserId are not allowed; ${resourceLabel} is scoped to the authenticated user`,
      },
      { status: 400 },
    );
  }
  return null;
}

function readBearerToken(request: Request): string | null {
  const authHeader = request.headers.get("authorization");
  if (!authHeader?.startsWith("Bearer ")) {
    return null;
  }
  const token = authHeader.slice("Bearer ".length).trim();
  return token || null;
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

function readExternalUserIdClaim(payload: Record<string, unknown>): string | null {
  const fromClaim = payload.external_user_id;
  if (typeof fromClaim === "string" && fromClaim.trim()) {
    return fromClaim.trim();
  }
  return null;
}

async function resolveDeveloperAppFromPublicClient(
  publicClientId: string,
): Promise<{ appId: string } | null> {
  const rows = await db
    .select({ appId: developerApps.id })
    .from(developerApps)
    .innerJoin(oidcClients, eq(developerApps.oidcClientId, oidcClients.id))
    .where(eq(oidcClients.clientId, publicClientId))
    .limit(1);
  return rows[0] ?? null;
}

async function resolveSignerJwtEndUser(
  payload: Record<string, unknown>,
): Promise<EndUserAuth | null> {
  const publicClientId = readTokenClientId(payload);
  const externalUserId =
    readExternalUserIdClaim(payload) ||
    (typeof payload.sub === "string" && payload.user_type === "external_user"
      ? payload.sub.trim()
      : null);
  if (!publicClientId || !externalUserId) {
    return null;
  }

  const developerApp = await resolveDeveloperAppFromPublicClient(publicClientId);
  if (!developerApp) {
    return null;
  }

  const appUserRows = await db
    .select({ externalUserId: appUsers.externalUserId })
    .from(appUsers)
    .where(
      and(
        eq(appUsers.clientId, developerApp.appId),
        eq(appUsers.externalUserId, externalUserId),
        eq(appUsers.status, "active"),
      ),
    )
    .limit(1);
  if (!appUserRows[0]) {
    return null;
  }

  return {
    publicClientId,
    developerAppId: developerApp.appId,
    externalUserId,
  };
}

/**
 * Authenticate an end-user Bearer credential for `/api/v1/user/*`.
 * Accepts programmatic user JWTs and signer JWTs (subject forced from the token).
 */
export async function authenticateEndUser(
  request: Request,
): Promise<EndUserAuth | null> {
  const token = readBearerToken(request);
  if (!token) {
    return null;
  }

  // Reject obvious API-key shapes here — full key resolution lives on feat/api-refactor.
  // Dashboard + Builder mint paths use JWTs.
  const looksLikeJwt = token.split(".").length === 3;
  const composite = splitCompositeApiKey(token);
  if (composite || !looksLikeJwt) {
    return null;
  }

  const payload = await verifyAccessToken(token);
  if (!payload) {
    return null;
  }
  const rec = payload as Record<string, unknown>;

  const signerResolved = await resolveSignerJwtEndUser(rec);
  if (signerResolved) {
    return signerResolved;
  }

  try {
    const resolved = await resolveSubjectAccessToken(token);
    return {
      publicClientId: resolved.publicClientId,
      developerAppId: resolved.developerAppId,
      externalUserId: resolved.externalUserId,
    };
  } catch (err) {
    if (err instanceof SubjectAccessTokenResolveError) {
      return null;
    }
    throw err;
  }
}
