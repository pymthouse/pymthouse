import { SignJWT } from "jose";
import { eq } from "drizzle-orm";
import { v4 as uuidv4 } from "uuid";
import { db } from "@/db/index";
import { developerApps, oidcClients } from "@/db/schema";
import { validateClientSecret } from "@/lib/oidc/clients";
import { ACCESS_TOKEN_JWT_TYP, ensureSigningKey } from "@/lib/oidc/jwks";
import { getIssuer } from "@/lib/oidc/issuer-urls";
import { provisionAppUserBilling } from "@/lib/billing/provision-app-user";
import { createSession } from "@/lib/auth";

export const SIGN_MINT_USER_TOKEN_SCOPE = "sign:mint_user_token";

const DEFAULT_SIGNER_JWT_TTL_SECONDS = 300;
const MIN_SIGNER_JWT_TTL_SECONDS = 60;
const MAX_SIGNER_JWT_TTL_SECONDS = 86400;
const DEFAULT_SIGNER_REFRESH_TTL_DAYS = 30;
const MIN_SIGNER_REFRESH_TTL_DAYS = 1;
const MAX_SIGNER_REFRESH_TTL_DAYS = 90;

/** Session label prefix for signer-JWT refresh tokens: `signer_refresh:{developerAppId}:{externalUserId}`. */
export const SIGNER_REFRESH_LABEL_PREFIX = "signer_refresh:";

function clampSignerJwtTtlSeconds(seconds: number): number {
  return Math.min(
    MAX_SIGNER_JWT_TTL_SECONDS,
    Math.max(MIN_SIGNER_JWT_TTL_SECONDS, Math.floor(seconds)),
  );
}

function envDefaultSignerJwtTtlSeconds(): number {
  const raw = process.env.SIGNER_JWT_TTL_SECONDS;
  const parsed = raw ? Number(raw) : Number.NaN;
  return Number.isFinite(parsed) && parsed > 0
    ? clampSignerJwtTtlSeconds(parsed)
    : DEFAULT_SIGNER_JWT_TTL_SECONDS;
}

/** Effective signer JWT TTL: per-app override (clamped) or the env/global default. */
export function resolveSignerJwtTtlSeconds(appTtlSeconds: number | null | undefined): number {
  return appTtlSeconds != null
    ? clampSignerJwtTtlSeconds(appTtlSeconds)
    : envDefaultSignerJwtTtlSeconds();
}

export function clampSignerRefreshTtlDays(days: number | null | undefined): number {
  const value = days ?? DEFAULT_SIGNER_REFRESH_TTL_DAYS;
  return Math.min(
    MAX_SIGNER_REFRESH_TTL_DAYS,
    Math.max(MIN_SIGNER_REFRESH_TTL_DAYS, Math.floor(value)),
  );
}

export class MintUserSignerTokenError extends Error {
  code: string;
  status: number;

  constructor(code: string, message: string, status = 400) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

function parseRequestedScopes(scopeParam: string | null | undefined): string[] {
  return (scopeParam || SIGN_MINT_USER_TOKEN_SCOPE)
    .split(/[\s,]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

export function isMintUserSignerTokenRequest(params: URLSearchParams): boolean {
  if (params.get("grant_type") !== "client_credentials") {
    return false;
  }
  const scopes = parseRequestedScopes(params.get("scope"));
  return scopes.includes(SIGN_MINT_USER_TOKEN_SCOPE);
}

function trimTrailingSlashes(value: string): string {
  let end = value.length;
  while (end > 0 && value[end - 1] === "/") {
    end -= 1;
  }
  return value.slice(0, end);
}

/** Signer JWT `aud` matches the OIDC issuer (same as Apache DMZ AuthJWTAud). */
export function signerJwtAudience(): string {
  return trimTrailingSlashes(getIssuer());
}

export async function mintSignerJwtForExternalUser(input: {
  publicClientId: string;
  developerAppId: string;
  externalUserId: string;
}) {
  const externalUserId = input.externalUserId.trim();
  if (!externalUserId) {
    throw new MintUserSignerTokenError(
      "invalid_request",
      "external_user_id is required",
    );
  }

  const { allowance } = await provisionAppUserBilling({
    clientId: input.developerAppId,
    externalUserId,
  });

  if (allowance && !allowance.hasAccess) {
    throw new MintUserSignerTokenError(
      "trial_credits_exhausted",
      "Starter allowance exhausted",
      402,
    );
  }

  const policyRows = await db
    .select({
      signerJwtTtlSeconds: developerApps.signerJwtTtlSeconds,
      signerRefreshEnabled: developerApps.signerRefreshEnabled,
      signerRefreshTtlDays: developerApps.signerRefreshTtlDays,
    })
    .from(developerApps)
    .where(eq(developerApps.id, input.developerAppId))
    .limit(1);
  const policy = policyRows[0];
  const ttlSeconds = resolveSignerJwtTtlSeconds(policy?.signerJwtTtlSeconds);

  const issuer = getIssuer();
  const audience = signerJwtAudience();
  const keyPair = await ensureSigningKey();
  const nowSeconds = Math.floor(Date.now() / 1000);

  const accessToken = await new SignJWT({
    scope: "sign:job",
    scp: ["sign:job"],
    client_id: input.publicClientId,
    external_user_id: externalUserId,
    user_type: "external_user",
  })
    .setProtectedHeader({ alg: "RS256", kid: keyPair.kid, typ: ACCESS_TOKEN_JWT_TYP })
    .setIssuer(issuer)
    .setAudience(audience)
    .setSubject(externalUserId)
    .setJti(uuidv4())
    .setIssuedAt(nowSeconds)
    .setNotBefore(nowSeconds)
    .setExpirationTime(nowSeconds + ttlSeconds)
    .sign(keyPair.privateKey);

  let refreshToken: string | undefined;
  if (policy?.signerRefreshEnabled) {
    const refresh = await createSession({
      appId: input.publicClientId,
      label: `${SIGNER_REFRESH_LABEL_PREFIX}${input.developerAppId}:${externalUserId}`,
      scopes: "sign:job",
      expiresInDays: clampSignerRefreshTtlDays(policy.signerRefreshTtlDays),
    });
    refreshToken = refresh.token;
  }

  return {
    access_token: accessToken,
    token_type: "Bearer" as const,
    expires_in: ttlSeconds,
    scope: "sign:job",
    balanceUsdMicros: allowance?.balanceUsdMicros ?? "0",
    lifetimeGrantedUsdMicros: allowance?.lifetimeGrantedUsdMicros ?? "0",
    ...(refreshToken ? { refresh_token: refreshToken } : {}),
  };
}

export async function handleMintUserSignerToken(input: {
  clientId: string;
  clientSecret: string;
  externalUserId: string;
  scope?: string | null;
}) {
  const externalUserId = input.externalUserId?.trim();
  if (!externalUserId) {
    throw new MintUserSignerTokenError(
      "invalid_request",
      "external_user_id is required",
    );
  }

  if (!(await validateClientSecret(input.clientId, input.clientSecret))) {
    throw new MintUserSignerTokenError("invalid_client", "Invalid client credentials", 401);
  }

  const appRows = await db
    .select({
      appId: developerApps.id,
    })
    .from(developerApps)
    .innerJoin(oidcClients, eq(developerApps.m2mOidcClientId, oidcClients.id))
    .where(eq(oidcClients.clientId, input.clientId))
    .limit(1);

  const row = appRows[0];
  if (!row) {
    throw new MintUserSignerTokenError("invalid_client", "Unknown M2M client", 401);
  }

  const m2mScopeRows = await db
    .select({ allowedScopes: oidcClients.allowedScopes })
    .from(oidcClients)
    .where(eq(oidcClients.clientId, input.clientId))
    .limit(1);
  const m2mScopes = new Set(
    (m2mScopeRows[0]?.allowedScopes || "")
      .split(/[\s,]+/)
      .map((s) => s.trim())
      .filter(Boolean),
  );
  if (!m2mScopes.has(SIGN_MINT_USER_TOKEN_SCOPE)) {
    throw new MintUserSignerTokenError(
      "invalid_scope",
      `M2M client lacks ${SIGN_MINT_USER_TOKEN_SCOPE}`,
    );
  }

  const publicClientRows = await db
    .select({ allowedScopes: oidcClients.allowedScopes, clientId: oidcClients.clientId })
    .from(developerApps)
    .innerJoin(oidcClients, eq(developerApps.oidcClientId, oidcClients.id))
    .where(eq(developerApps.id, row.appId))
    .limit(1);
  const publicClient = publicClientRows[0];
  if (!publicClient?.allowedScopes.includes("sign:job")) {
    throw new MintUserSignerTokenError(
      "invalid_scope",
      "Public app client must allow sign:job",
    );
  }

  return mintSignerJwtForExternalUser({
    publicClientId: publicClient.clientId,
    developerAppId: row.appId,
    externalUserId,
  });
}
