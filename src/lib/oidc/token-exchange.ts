import * as jose from "jose";
import { db } from "@/db/index";
import { developerApps, oidcClients } from "@/db/schema";
import { eq } from "drizzle-orm";
import { validateClientSecret } from "./clients";
import { ensureSigningKey } from "./jwks";
import { getIssuer, getPlatformJwksUrlForDatabase } from "./issuer-urls";
import { fetchPlatformJWKS } from "./jwks-fetch";
import { findOrCreateAppEndUser } from "@/lib/billing";
import { billingPatternFromAllowedScopesString } from "@/lib/allowed-scopes";

const TOKEN_EXCHANGE_GRANT = "urn:ietf:params:oauth:grant-type:token-exchange";
const JWT_TOKEN_TYPE = "urn:ietf:params:oauth:token-type:jwt";
const ACCESS_TOKEN_TYPE = "urn:ietf:params:oauth:token-type:access_token";

export interface TokenExchangeResult {
  access_token: string;
  token_type: "Bearer";
  expires_in: number;
  scope: string;
  issued_token_type: string;
}

export function isTokenExchangeGrant(grantType: string): boolean {
  return grantType === TOKEN_EXCHANGE_GRANT;
}

export async function handleTokenExchange(params: {
  clientId: string;
  clientSecret: string;
  subjectToken: string;
  subjectTokenType: string;
  scope?: string;
  resource?: string;
}): Promise<TokenExchangeResult> {
  const {
    clientId,
    clientSecret,
    subjectToken,
    subjectTokenType,
    scope,
  } = params;

  if (subjectTokenType !== JWT_TOKEN_TYPE) {
    throw new TokenExchangeError(
      "unsupported_token_type",
      `subject_token_type must be ${JWT_TOKEN_TYPE}`,
      "Unsupported subject token type",
    );
  }

  if (!(await validateClientSecret(clientId, clientSecret))) {
    throw new TokenExchangeError(
      "invalid_client",
      "Invalid client credentials",
      "Invalid client credentials",
    );
  }

  const clientRows = await db
    .select()
    .from(oidcClients)
    .where(eq(oidcClients.clientId, clientId))
    .limit(1);
  const clientRow = clientRows[0];
  if (!clientRow) {
    throw new TokenExchangeError(
      "invalid_client",
      "Client not found",
      "Invalid client credentials",
    );
  }

  const appRows = await db
    .select()
    .from(developerApps)
    .where(eq(developerApps.oidcClientId, clientRow.id))
    .limit(1);
  const app = appRows[0];
  if (!app || app.status !== "approved") {
    throw new TokenExchangeError(
      "invalid_client",
      "App is not approved for token exchange",
      "Client is not approved for token exchange",
    );
  }

  if (billingPatternFromAllowedScopesString(clientRow.allowedScopes) !== "per_user") {
    throw new TokenExchangeError(
      "invalid_request",
      "Token exchange requires the users:token scope on the OAuth client",
      "Token exchange requires per-user billing (users:token scope)",
    );
  }

  const jwksUriForExchange =
    !app.jwksUri?.trim() ||
    app.jwksUri.includes("localhost") ||
    app.jwksUri.includes("127.0.0.1")
      ? getPlatformJwksUrlForDatabase()
      : app.jwksUri.trim();

  let platformJWKS: jose.JSONWebKeySet;
  try {
    platformJWKS = await fetchPlatformJWKS(jwksUriForExchange);
  } catch (err) {
    throw new TokenExchangeError(
      "invalid_request",
      `Failed to fetch platform JWKS: ${err instanceof Error ? err.message : "unknown error"}`,
      "Unable to validate subject token",
    );
  }

  let payload: jose.JWTPayload;
  try {
    const keySet = jose.createLocalJWKSet(platformJWKS);
    const result = await jose.jwtVerify(subjectToken, keySet);
    payload = result.payload;
  } catch (err) {
    throw new TokenExchangeError(
      "invalid_grant",
      `Subject token verification failed: ${err instanceof Error ? err.message : "invalid signature"}`,
      "Invalid subject token",
    );
  }

  const externalSub = payload.sub;
  if (!externalSub) {
    throw new TokenExchangeError(
      "invalid_grant",
      "Subject token missing sub claim",
      "Invalid subject token",
    );
  }

  const { id: endUserId } = await findOrCreateAppEndUser(app.id, externalSub);

  const requestedScopes = (scope || "")
    .split(/\s+/)
    .filter(Boolean);
  const allowedScopes = clientRow.allowedScopes.split(/[,\s]+/).filter(Boolean);
  const grantedScopes = requestedScopes.filter((s) => allowedScopes.includes(s));
  const scopeString = grantedScopes.join(" ") || "sign:job";

  const issuer = getIssuer();
  const signingKey = await ensureSigningKey();
  const expiresIn = 3600;

  const accessToken = await new jose.SignJWT({
    client_id: clientId,
    scope: scopeString,
    token_exchange: true,
  })
    .setProtectedHeader({ alg: "RS256", kid: signingKey.kid })
    .setSubject(endUserId)
    .setIssuer(issuer)
    .setAudience(issuer)
    .setIssuedAt()
    .setExpirationTime(`${expiresIn}s`)
    .setJti(`te_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`)
    .sign(signingKey.privateKey);

  return {
    access_token: accessToken,
    token_type: "Bearer",
    expires_in: expiresIn,
    scope: scopeString,
    issued_token_type: ACCESS_TOKEN_TYPE,
  };
}

export class TokenExchangeError extends Error {
  code: string;
  publicDescription: string;
  constructor(
    code: string,
    message: string,
    publicDescription?: string,
  ) {
    super(message);
    this.code = code;
    this.publicDescription = publicDescription || message;
  }
}
