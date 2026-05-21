/**
 * Deterministic PBKDF2-SHA256 hashing for high-entropy credential material
 * (bearer tokens, API keys, OIDC refresh tokens, admin invite codes).
 *
 * Why deterministic PBKDF2 and not per-record random salt:
 *   These values are 256-bit random secrets, not user passwords. The hash
 *   column is used as an indexed equality-lookup key (`WHERE token_hash = $1`),
 *   so the KDF must map one plaintext to exactly one digest. We achieve
 *   constant-time verification at the database level via the unique index,
 *   and CWE-916 ("insufficient computational effort") is satisfied by the
 *   OWASP-recommended PBKDF2 iteration count.
 *
 * Why a server-side pepper:
 *   A global, deployment-scoped secret salt makes offline brute-force of
 *   a stolen `token_hash` dump require also compromising the application
 *   secret — the standard pepper pattern.
 *
 * Compatibility: digest is 64 hex chars, same shape as the previous
 * `createHash("sha256")` output, so existing column types and unique
 * indexes require no migration. Existing row values must be rotated
 * manually (hard cutover, no SHA-256 fallback).
 */

import { pbkdf2Sync } from "crypto";

const TOKEN_HASH_ITERATIONS = 600_000;
const TOKEN_HASH_KEYLEN = 32;
const TOKEN_HASH_DIGEST = "sha256";
const MIN_PEPPER_LENGTH = 32;

let cachedPepper: string | null = null;

function loadPepper(): string {
  if (cachedPepper !== null) return cachedPepper;

  const pepper = process.env.AUTH_TOKEN_PEPPER?.trim();
  if (!pepper || pepper.length < MIN_PEPPER_LENGTH) {
    throw new Error(
      `AUTH_TOKEN_PEPPER is required (min ${MIN_PEPPER_LENGTH} chars). ` +
        `Generate one with: openssl rand -base64 48`,
    );
  }

  cachedPepper = pepper;
  return pepper;
}

/**
 * Deterministic PBKDF2-SHA256 hash of a credential value, keyed by the
 * server-side pepper. Returns a 64-character lowercase hex string suitable
 * for direct equality comparison in the database.
 */
export function hashToken(token: string): string {
  return pbkdf2Sync(
    token,
    loadPepper(),
    TOKEN_HASH_ITERATIONS,
    TOKEN_HASH_KEYLEN,
    TOKEN_HASH_DIGEST,
  ).toString("hex");
}
