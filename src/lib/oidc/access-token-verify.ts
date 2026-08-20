import * as jose from "jose";
import { getCanonicalIssuer } from "./issuer-urls";
import { getMcpResourceUrl } from "@/lib/mcp/oauth-resource";

/**
 * Verify a JWT access token issued by the OIDC provider.
 *
 * Default audience is the canonical issuer only. MCP-bound (RFC 8707) tokens
 * must pass `{ audience: getMcpResourceUrl() }` so they cannot be replayed
 * against general platform APIs.
 */
export async function verifyAccessToken(
  token: string,
  options?: { audience?: string | string[] },
): Promise<jose.JWTPayload | null> {
  try {
    const issuer = getCanonicalIssuer();
    const { getPublicJWKS } = await import("./jwks");
    const jwks = await getPublicJWKS();
    const keySet = jose.createLocalJWKSet(jwks);

    const audience = options?.audience ?? issuer;

    const { payload } = await jose.jwtVerify(token, keySet, {
      issuer,
      audience,
    });

    return payload;
  } catch {
    return null;
  }
}

/** Accept either a platform-issuer token or an MCP resource-bound token. */
export async function verifyIssuerOrMcpAccessToken(
  token: string,
): Promise<jose.JWTPayload | null> {
  return (
    (await verifyAccessToken(token)) ??
    (await verifyAccessToken(token, { audience: getMcpResourceUrl() }))
  );
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
