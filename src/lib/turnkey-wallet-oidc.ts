import { createHash } from "node:crypto";
import { SignJWT } from "jose";
import { v4 as uuidv4 } from "uuid";
import { ensureSigningKey, getPublicJWKS } from "@/lib/oidc/jwks";
import { getPublicOrigin } from "@/lib/oidc/issuer-urls";
import { TURNKEY_WALLET_PROVIDER_NAME } from "@/lib/turnkey-wallet-provider";

export { TURNKEY_WALLET_PROVIDER_NAME };

/** Issuer Turnkey fetches for every PymtHouse wallet login, regardless of button. */
export const TURNKEY_WALLET_OIDC_MOUNT = "/api/v1/turnkey-wallet-oidc";

/** Stable audience. Part of Turnkey's (iss, sub, aud) fingerprint. */
export const TURNKEY_WALLET_OIDC_AUDIENCE = "urn:pymthouse:turnkey-wallet";

const ID_TOKEN_TTL_SECONDS = 5 * 60;

function trimTrailingSlash(value: string): string {
  let out = value;
  while (out.endsWith("/")) {
    out = out.slice(0, -1);
  }
  return out;
}

export function getTurnkeyWalletOidcIssuer(): string {
  const override = process.env.TURNKEY_WALLET_OIDC_ISSUER?.trim();
  if (override) return trimTrailingSlash(override);
  return `${getPublicOrigin()}${TURNKEY_WALLET_OIDC_MOUNT}`;
}

/**
 * Match Wallet Kit: `bytesToHex(sha256(utf8(publicKeyHex)))`.
 * Turnkey binds the OIDC nonce to the browser session public key.
 */
export function turnkeyOauthNonceFromPublicKey(publicKey: string): string {
  // codeql[js/insufficient-password-hash]
  // lgtm[js/insufficient-password-hash]
  return createHash("sha256").update(publicKey, "utf8").digest("hex");
}

export function walletOidcSubject(userId: string): string {
  return userId.trim();
}

export async function getTurnkeyWalletPublicJwks() {
  return getPublicJWKS();
}

export function buildTurnkeyWalletOpenIdConfiguration() {
  const issuer = getTurnkeyWalletOidcIssuer();
  return {
    issuer,
    jwks_uri: `${issuer}/jwks`,
    response_types_supported: ["id_token"],
    subject_types_supported: ["public"],
    id_token_signing_alg_values_supported: ["RS256"],
    claims_supported: ["iss", "sub", "aud", "exp", "iat", "nonce", "email", "name"],
  };
}

export async function mintTurnkeyWalletOidcToken(input: {
  userId: string;
  nonce: string;
  email?: string | null;
  name?: string | null;
}): Promise<string> {
  const userId = input.userId.trim();
  if (!userId) throw new Error("Wallet OIDC subject is required");
  const issuer = getTurnkeyWalletOidcIssuer();
  const keyPair = await ensureSigningKey();
  const nowSeconds = Math.floor(Date.now() / 1000);
  const claims: Record<string, string> = { nonce: input.nonce };
  const email = input.email?.trim();
  if (email) claims.email = email;
  const name = input.name?.trim();
  if (name) claims.name = name;

  return new SignJWT(claims)
    .setProtectedHeader({
      alg: "RS256",
      kid: keyPair.kid,
      typ: "JWT",
    })
    .setIssuer(issuer)
    .setAudience(TURNKEY_WALLET_OIDC_AUDIENCE)
    .setSubject(walletOidcSubject(userId))
    .setJti(uuidv4())
    .setIssuedAt(nowSeconds)
    .setExpirationTime(nowSeconds + ID_TOKEN_TTL_SECONDS)
    .sign(keyPair.privateKey);
}
