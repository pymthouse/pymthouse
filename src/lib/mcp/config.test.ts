import assert from "node:assert/strict";
import test from "node:test";

import { extractBearerToken } from "@/lib/mcp/config";

test("extractBearerToken accepts Bearer and raw tokens", () => {
  assert.equal(extractBearerToken("Bearer abc"), "abc");
  assert.equal(extractBearerToken("raw-key"), "raw-key");
});

test("extractBearerToken rejects empty", () => {
  assert.throws(() => extractBearerToken(null), /required/);
  assert.throws(() => extractBearerToken("   "), /required/);
});
