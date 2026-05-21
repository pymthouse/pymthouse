import test from "node:test";
import assert from "node:assert/strict";
import { verifyTurnkeySessionJwt } from "./turnkey";

test("verifyTurnkeySessionJwt rejects malformed token", async () => {
  const out = await verifyTurnkeySessionJwt("not-a-jwt");
  assert.equal(out, null);
});

test("verifyTurnkeySessionJwt rejects empty", async () => {
  const out = await verifyTurnkeySessionJwt("   ");
  assert.equal(out, null);
});
