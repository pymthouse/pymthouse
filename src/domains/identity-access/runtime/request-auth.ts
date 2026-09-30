import { randomBytes } from "crypto";
import { v4 as uuidv4 } from "uuid";
import type { NextRequest } from "next/server";
import { validateClientSecret } from "@/domains/oidc-platform/runtime/clients";
import { verifyAccessToken } from "@/domains/oidc-platform/runtime/access-token-verify";
import { hashToken } from "@/shared/utils/token-hash";
import {
  createStoredSession,
  consumeSessionByIdHashAndExpiry,
  deleteSessionById,
  getActiveSessionByTokenHash,
} from "../repo/sessions";
import {
  getDeveloperAppForOidcClientRow,
  getOidcClientIdByRowId,
  getOidcClientRowByClientId,
} from "../repo/app-clients";
import { listSessionsForAdminView } from "../repo/sessions";

export { hashToken };

const TOKEN_PREFIX = "pmth_";
const DEBUG_OIDC_LOGS = process.env.OIDC_DEBUG_LOGS === "1";

export interface AuthResult {
  userId: string | null;
  endUserId: string | null;
  appId: string | null;
  sessionId: string;
  label?: string | null;
  scopes: string;
  tokenHash: string;
}

export function decodeBasicAuthComponent(value: string): string {
  try {
    return decodeURIComponent(value.replace(/\+/g, " "));
  } catch {
    return value;
  }
}

export function generateBearerToken(): { token: string; hash: string } {
  const raw = randomBytes(32).toString("hex");
  const token = `${TOKEN_PREFIX}${raw}`;
  return { token, hash: hashToken(token) };
}

async function createSessionWithExpiryMs(opts: {
  userId?: string;
  endUserId?: string;
  appId?: string;
  label?: string;
  scopes: string;
  expiresInMs: number;
}): Promise<{ sessionId: string; token: string }> {
  const { userId, endUserId, appId, label, scopes, expiresInMs } = opts;
  const safeExpiresInMs = Math.max(1, Math.floor(expiresInMs));
  const { token, hash } = generateBearerToken();
  const sessionId = uuidv4();
  const expiresAt = new Date(Date.now() + safeExpiresInMs).toISOString();

  await createStoredSession({
    id: sessionId,
    userId,
    endUserId,
    appId,
    label,
    tokenHash: hash,
    scopes,
    expiresAt,
  });

  return { sessionId, token };
}

export async function createSession(opts: {
  userId?: string;
  endUserId?: string;
  appId?: string;
  label?: string;
  scopes?: string;
  expiresInDays?: number;
}) {
  return createSessionWithExpiryMs({
    ...opts,
    scopes: opts.scopes || "sign:job",
    expiresInMs: (opts.expiresInDays || 90) * 24 * 60 * 60 * 1000,
  });
}

export async function createShortLivedSession(opts: {
  userId?: string;
  endUserId?: string;
  appId?: string;
  label?: string;
  scopes?: string;
  expiresInMinutes: number;
}) {
  return createSessionWithExpiryMs({
    ...opts,
    scopes: opts.scopes || "sign:job",
    expiresInMs: opts.expiresInMinutes * 60 * 1000,
  });
}

export async function revokeSession(sessionId: string) {
  return deleteSessionById(sessionId);
}

export async function listActiveAdminSessions() {
  return listSessionsForAdminView();
}

export async function consumeSessionByIdAndToken(
  sessionId: string,
  token: string,
): Promise<AuthResult | null> {
  if (!token.startsWith(TOKEN_PREFIX)) return null;
  const tokenHash = hashToken(token);
  const row = await consumeSessionByIdHashAndExpiry({
    sessionId,
    tokenHash,
    now: new Date().toISOString(),
  });
  if (!row) return null;

  return {
    userId: row.userId,
    endUserId: row.endUserId,
    appId: row.appId || null,
    sessionId: row.id,
    label: row.label || null,
    scopes: row.scopes,
    tokenHash,
  };
}

export async function validateBearerToken(token: string): Promise<AuthResult | null> {
  if (!token.startsWith(TOKEN_PREFIX)) return null;
  const tokenHash = hashToken(token);
  const session = await getActiveSessionByTokenHash(tokenHash, new Date().toISOString());
  if (!session) return null;

  return {
    userId: session.userId,
    endUserId: session.endUserId,
    appId: session.appId || null,
    sessionId: session.id,
    label: session.label || null,
    scopes: session.scopes,
    tokenHash,
  };
}

export function hasScope(scopes: string, required: string): boolean {
  if (!scopes) return false;
  if (scopes === "admin") return true;
  return scopes
    .split(/[,\s]+/)
    .map((s) => s.trim())
    .filter(Boolean)
    .includes(required);
}

export async function authenticateRequest(request: NextRequest): Promise<AuthResult | null> {
  const authHeader = request.headers.get("authorization");
  if (!authHeader?.startsWith("Bearer ")) return null;
  return validateBearerToken(authHeader.slice(7));
}

export async function authenticateRequestAsync(request: NextRequest): Promise<AuthResult | null> {
  const authHeader = request.headers.get("authorization");
  if (!authHeader?.startsWith("Bearer ")) return null;
  const token = authHeader.slice(7);

  const sessionResult = await validateBearerToken(token);
  if (sessionResult) return sessionResult;

  const jwtPayload = await verifyAccessToken(token);
  if (!jwtPayload) {
    if (DEBUG_OIDC_LOGS) {
      const parts = token.split(".");
      const isJwtShaped = parts.length === 3;
      console.warn(
        "[OIDC] bearer token rejected by JWT verifier:",
        isJwtShaped ? "JWT signature/issuer/audience mismatch" : "not a JWT (opaque token?)",
      );
    }
    return null;
  }

  const scopeFromScope =
    typeof jwtPayload.scope === "string" ? jwtPayload.scope : "";
  const scpRaw = (jwtPayload as Record<string, unknown>).scp;
  const scopeFromScp =
    Array.isArray(scpRaw)
      ? scpRaw.filter((v): v is string => typeof v === "string").join(" ")
      : typeof scpRaw === "string"
        ? scpRaw
        : "";
  const effectiveScopes = (scopeFromScope || scopeFromScp).trim().replace(/\s+/g, ",");

  return {
    userId: typeof jwtPayload.sub === "string" ? jwtPayload.sub : null,
    endUserId: null,
    appId: typeof jwtPayload.client_id === "string" ? jwtPayload.client_id : null,
    sessionId: typeof jwtPayload.jti === "string" ? jwtPayload.jti : `jwt_${Date.now()}`,
    scopes: effectiveScopes,
    tokenHash: "",
  };
}

export class AuthError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

export async function requireAuth(request: NextRequest, requiredScope: string) {
  const auth = await authenticateRequest(request);
  if (!auth) {
    throw new AuthError("Unauthorized: invalid or expired token", 401);
  }
  if (!hasScope(auth.scopes, requiredScope)) {
    throw new AuthError(`Forbidden: requires '${requiredScope}' scope`, 403);
  }
  return auth;
}

export async function authenticateAppClient(request: NextRequest): Promise<{
  clientId: string;
  appId: string;
  scopes: string;
} | null> {
  let clientId: string | null = null;
  let clientSecret: string | null = null;

  const authHeader = request.headers.get("authorization") || "";
  if (authHeader.startsWith("Basic ")) {
    const decoded = Buffer.from(authHeader.slice(6), "base64").toString("utf-8");
    const colonIdx = decoded.indexOf(":");
    if (colonIdx > 0) {
      clientId = decodeBasicAuthComponent(decoded.slice(0, colonIdx));
      clientSecret = decodeBasicAuthComponent(decoded.slice(colonIdx + 1));
    }
  }

  if (!clientId || !clientSecret) return null;
  if (!(await validateClientSecret(clientId, clientSecret))) return null;

  const clientRow = await getOidcClientRowByClientId(clientId);
  if (!clientRow) return null;

  const app = await getDeveloperAppForOidcClientRow(clientRow.id);
  const oidcRowIdForAppId = app?.oidcClientId ?? app?.m2mOidcClientId;
  if (!app || !oidcRowIdForAppId) return null;

  const resolvedAppOidcClientId = await getOidcClientIdByRowId(oidcRowIdForAppId);
  if (!resolvedAppOidcClientId) return null;

  return {
    clientId,
    appId: resolvedAppOidcClientId,
    scopes: clientRow.allowedScopes,
  };
}
