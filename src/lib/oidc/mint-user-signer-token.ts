import { SignJWT } from "jose";
import { eq } from "drizzle-orm";
import { v4 as uuidv4 } from "uuid";
import { db } from "@/db/index";
import { developerApps, oidcClients } from "@/db/schema";
import { validateClientSecret } from "@/lib/oidc/clients";
import { ACCESS_TOKEN_JWT_TYP, ensureSigningKey } from "@/lib/oidc/jwks";
import { getIssuer } from "@/lib/oidc/issuer-urls";
import { provisionAppUserBilling } from "@/lib/billing/provision-app-user";
import { buildSignerSessionEnvelope } from "@/lib/openapi/signer-session";
import { getClientSignerApiUrl } from "@/lib/signer-proxy";

export const SIGN_MINT_USER_TOKEN_SCOPE = "sign:mint_user_token";
const SIGNER_JWT_TTL_SECONDS = 300;

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
    .setExpirationTime(nowSeconds + SIGNER_JWT_TTL_SECONDS)
    .sign(keyPair.privateKey);

  return {
    access_token: accessToken,
    token_type: "Bearer" as const,
    expires_in: SIGNER_JWT_TTL_SECONDS,
    scope: "sign:job",
    balanceUsdMicros: allowance?.balanceUsdMicros ?? "0",
    lifetimeGrantedUsdMicros: allowance?.lifetimeGrantedUsdMicros ?? "0",
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

  const minted = await mintSignerJwtForExternalUser({
    publicClientId: publicClient.clientId,
    developerAppId: row.appId,
    externalUserId,
  });
  return buildSignerSessionEnvelope({
    access_token: minted.access_token,
    expires_in: minted.expires_in,
    scope: minted.scope,
    balanceUsdMicros: minted.balanceUsdMicros,
    lifetimeGrantedUsdMicros: minted.lifetimeGrantedUsdMicros,
    signer_url: getClientSignerApiUrl(),
    issued_token_type: "urn:ietf:params:oauth:token-type:access_token",
  });
}
