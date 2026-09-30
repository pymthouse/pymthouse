import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  TURNKEY_WALLET_OIDC_AUDIENCE,
  turnkeyOauthNonceFromPublicKey,
  walletOidcSubject,
} from "./turnkey-wallet-oidc";

test("wallet oidc subject is the PymtHouse user id", () => {
  assert.equal(walletOidcSubject("  user-1  "), "user-1");
});

test("wallet oidc audience is stable", () => {
  assert.equal(TURNKEY_WALLET_OIDC_AUDIENCE, "urn:pymthouse:turnkey-wallet");
});

test("oauth nonce is sha256 of the utf8 public key", () => {
  const publicKey = "02" + "ab".repeat(32);
  assert.equal(
    turnkeyOauthNonceFromPublicKey(publicKey),
    createHash("sha256").update(publicKey, "utf8").digest("hex"),
  );
});
