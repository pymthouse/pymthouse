import assert from "node:assert/strict";
import { test } from "node:test";

import { sanitizeForLog } from "./sanitize-for-log";

test("sanitizeForLog strips CR and LF", () => {
  assert.equal(sanitizeForLog("a\nb\rc"), "abc");
});

test("sanitizeForLog coerces nullish to empty string", () => {
  assert.equal(sanitizeForLog(null), "");
  assert.equal(sanitizeForLog(undefined), "");
});

test("sanitizeForLog stringifies non-strings", () => {
  assert.equal(sanitizeForLog(42), "42");
  assert.equal(sanitizeForLog(true), "true");
});
