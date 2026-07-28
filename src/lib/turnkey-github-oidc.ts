import { createHash } from "node:crypto";
import { SignJWT } from "jose";
import { v4 as uuidv4 } from "uuid";
import { ensureSigningKey, getPublicJWKS } from "@/lib/oidc/jwks";
import { getPublicOrigin } from "@/lib/oidc/issuer-urls";

/** Dedicated issuer path for GitHub → Turnkey BYO OIDC (OAuth2 wrapper). */
export const TURNKEY_GITHUB_OIDC_MOUNT = "/api/v1/turnkey-github-oidc";

/** Stable audience claim; part of Turnkey's (iss, sub, aud) identity fingerprint. */
export const TURNKEY_GITHUB_OIDC_AUDIENCE = "urn:pymthouse:turnkey-github";

export const TURNKEY_GITHUB_PROVIDER_NAME = "GitHub";

const ID_TOKEN_TTL_SECONDS = 5 * 60;

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

/** Public issuer URL Turnkey fetches for discovery + JWKS. Must be internet-reachable. */
export function getTurnkeyGithubOidcIssuer(): string {
  const override = process.env.TURNKEY_GITHUB_OIDC_ISSUER?.trim();
  if (override) return trimTrailingSlash(override);
  return `${getPublicOrigin()}${TURNKEY_GITHUB_OIDC_MOUNT}`;
}

export function getTurnkeyGithubOidcJwksUrl(): string {
  return `${getTurnkeyGithubOidcIssuer()}/jwks`;
}

/** Match Wallet Kit: `bytesToHex(sha256(utf8(publicKeyHex)))`. */
export function turnkeyOauthNonceFromPublicKey(publicKey: string): string {
  return createHash("sha256").update(publicKey, "utf8").digest("hex");
}

export function githubOidcSubject(githubUserId: string | number): string {
  return `github:${String(githubUserId)}`;
}

export async function getTurnkeyGithubPublicJwks() {
  return getPublicJWKS();
}

export function buildTurnkeyGithubOpenIdConfiguration() {
  const issuer = getTurnkeyGithubOidcIssuer();
  return {
    issuer,
    jwks_uri: `${issuer}/jwks`,
    response_types_supported: ["id_token"],
    subject_types_supported: ["public"],
    id_token_signing_alg_values_supported: ["RS256"],
    claims_supported: [
      "iss",
      "sub",
      "aud",
      "exp",
      "iat",
      "nonce",
      "email",
      "name",
      "preferred_username",
    ],
  };
}

export async function mintTurnkeyGithubOidcToken(input: {
  githubUserId: string | number;
  nonce: string;
  email?: string | null;
  name?: string | null;
  login?: string | null;
}): Promise<string> {
  const issuer = getTurnkeyGithubOidcIssuer();
  const keyPair = await ensureSigningKey();
  const nowSeconds = Math.floor(Date.now() / 1000);

  const claims: Record<string, string> = {
    nonce: input.nonce,
  };
  const email = input.email?.trim();
  if (email) claims.email = email;
  const name = input.name?.trim();
  if (name) claims.name = name;
  const login = input.login?.trim();
  if (login) claims.preferred_username = login;

  return new SignJWT(claims)
    .setProtectedHeader({
      alg: "RS256",
      kid: keyPair.kid,
      typ: "JWT",
    })
    .setIssuer(issuer)
    .setAudience(TURNKEY_GITHUB_OIDC_AUDIENCE)
    .setSubject(githubOidcSubject(input.githubUserId))
    .setJti(uuidv4())
    .setIssuedAt(nowSeconds)
    .setExpirationTime(nowSeconds + ID_TOKEN_TTL_SECONDS)
    .sign(keyPair.privateKey);
}
