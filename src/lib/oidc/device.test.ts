import test from "node:test";
import assert from "node:assert/strict";

import {
  DEVICE_USER_CODE_LENGTH,
  isCompleteUserCode,
  normalizeUserCode,
} from "@/lib/oidc/device";

test("normalizeUserCode follows provider normalization rules", () => {
  assert.equal(normalizeUserCode("abcd-1234"), "ABCD1234");
  assert.equal(normalizeUserCode("  ab cd_12  "), "ABCD_12");
  assert.equal(normalizeUserCode("qwer-tyui"), "QWERTYUI");
});

test("DEVICE_USER_CODE_LENGTH matches provider mask", () => {
  assert.equal(DEVICE_USER_CODE_LENGTH, 8);
});

test("isCompleteUserCode accepts masked codes with separators", () => {
  assert.equal(isCompleteUserCode("JGBZ-LVDC"), true);
  assert.equal(isCompleteUserCode("JGBZ LVDC"), true);
  assert.equal(isCompleteUserCode("JGBZ-LVD"), false);
  assert.equal(isCompleteUserCode("JGBZLVDC"), true);
});
