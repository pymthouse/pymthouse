import test from "node:test";
import assert from "node:assert/strict";
import {
  normalizeWalletAddress,
  verifyTurnkeySessionJwt,
} from "./turnkey";

test("normalizeWalletAddress lowercases valid EVM addresses", () => {
  const mixed = `0x${"Ab".repeat(20)}`;
  assert.equal(
    normalizeWalletAddress(mixed),
    `0x${"ab".repeat(20)}`,
  );
});

test("normalizeWalletAddress rejects invalid input", () => {
  assert.equal(normalizeWalletAddress(""), null);
  assert.equal(normalizeWalletAddress("not-an-address"), null);
  assert.equal(normalizeWalletAddress(undefined), null);
});

test("verifyTurnkeySessionJwt rejects malformed token", async () => {
  const out = await verifyTurnkeySessionJwt("not-a-jwt");
  assert.equal(out, null);
});

test("verifyTurnkeySessionJwt rejects empty", async () => {
  const out = await verifyTurnkeySessionJwt("   ");
  assert.equal(out, null);
});
