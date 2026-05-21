import test from "node:test";
import assert from "node:assert/strict";

import { normalizeUserCode } from "@/platform/oidc/device";

test("normalizeUserCode follows provider normalization rules", () => {
  assert.equal(normalizeUserCode("abcd-1234"), "ABCD1234");
  assert.equal(normalizeUserCode("  ab cd_12  "), "ABCD_12");
  assert.equal(normalizeUserCode("qwer-tyui"), "QWERTYUI");
});
