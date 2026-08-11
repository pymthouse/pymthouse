import * as jose from "jose";
import { getCanonicalIssuer } from "./issuer-urls";
import { getMcpResourceUrl } from "@/lib/mcp/oauth-resource";

/**
 * Verify a JWT access token issued by the OIDC provider.
 *
 * Accepts audience = canonical issuer (default) or the hosted MCP resource URL.
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

    const audience =
      options?.audience ??
      ([issuer, getMcpResourceUrl()] as string[]);

    const { payload } = await jose.jwtVerify(token, keySet, {
      issuer,
      audience,
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
      audience: [expectedIssuer, getMcpResourceUrl()],
    });

    return payload;
  } catch {
    return null;
  }
}
