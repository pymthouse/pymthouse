import * as jose from "jose";
import { getCanonicalIssuer } from "./issuer-urls";

/**
 * Verify a JWT access token issued by the OIDC provider.
 *
 * Validates the signature against the local JWKS, checks issuer, and
 * verifies the audience matches.
 *
 * This function always validates against the canonical issuer, even when
 * custom domains or future per-tenant issuers are in use. Token validation
 * is issuer-centric and centralized for security.
 */
export async function verifyAccessToken(
  token: string,
): Promise<jose.JWTPayload | null> {
  try {
    const issuer = getCanonicalIssuer();
    const { getPublicJWKS } = await import("./jwks");
    const jwks = await getPublicJWKS();
    const keySet = jose.createLocalJWKSet(jwks);

    const { payload } = await jose.jwtVerify(token, keySet, {
      issuer,
      audience: issuer,
    });

    return payload;
  } catch {
    return null;
  }
}

/**
 * Verify a JWT access token with explicit issuer override.
 * Reserved for future multi-issuer support.
 */
export async function verifyAccessTokenWithIssuer(
  token: string,
  expectedIssuer: string,
): Promise<jose.JWTPayload | null> {
  try {
    const canonicalIssuer = getCanonicalIssuer();

    if (expectedIssuer !== canonicalIssuer) {
      return null;
    }

    const { getPublicJWKS } = await import("./jwks");
    const jwks = await getPublicJWKS();
    const keySet = jose.createLocalJWKSet(jwks);

    const { payload } = await jose.jwtVerify(token, keySet, {
      issuer: expectedIssuer,
      audience: expectedIssuer,
    });

    return payload;
  } catch {
    return null;
  }
}
