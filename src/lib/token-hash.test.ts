import test from "node:test";
import assert from "node:assert/strict";

import {
  apiKeyLookupHashes,
  hashToken,
  hashTokenLegacySha256,
} from "@/lib/token-hash";

test("apiKeyLookupHashes returns current and legacy digests", () => {
  const token = "pmth_" + "e".repeat(64);
  const hashes = apiKeyLookupHashes(token);
  assert.equal(hashes.length, 2);
  assert.equal(hashes[0], hashToken(token));
  assert.equal(hashes[1], hashTokenLegacySha256(token));
  assert.notEqual(hashes[0], hashes[1]);
});
