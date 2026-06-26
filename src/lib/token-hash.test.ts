import test from "node:test";
import assert from "node:assert/strict";

import { hashToken } from "@/lib/token-hash";

test("hashToken is deterministic for the same token", () => {
  const token = "pmth_" + "e".repeat(64);
  const first = hashToken(token);
  const second = hashToken(token);
  assert.equal(first, second);
  assert.equal(first.length, 64);
});
