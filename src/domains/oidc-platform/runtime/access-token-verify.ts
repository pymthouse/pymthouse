import * as jose from "jose";
import { getCanonicalIssuer } from "@/platform/oidc/issuer-urls";
import { getPublicJWKS } from "./jwks";

export async function verifyAccessToken(token: string): Promise<jose.JWTPayload | null> {
  try {
    const issuer = getCanonicalIssuer();
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

export async function verifyAccessTokenWithIssuer(
  token: string,
  expectedIssuer: string,
): Promise<jose.JWTPayload | null> {
  try {
    const canonicalIssuer = getCanonicalIssuer();
    if (expectedIssuer !== canonicalIssuer) return null;
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
