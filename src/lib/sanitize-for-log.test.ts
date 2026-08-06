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

test("sanitizeForLog stringifies primitives", () => {
  assert.equal(sanitizeForLog(42), "42");
  assert.equal(sanitizeForLog(true), "true");
  assert.equal(sanitizeForLog(9007199254740993n), "9007199254740993");
  assert.equal(sanitizeForLog(Symbol("tok\nen")), "Symbol(token)");
});

test("sanitizeForLog drops values it cannot render", () => {
  assert.equal(
    sanitizeForLog(() => "never logged"),
    "",
  );
});

test("sanitizeForLog falls back when JSON.stringify throws", () => {
  const cyclic: Record<string, unknown> = {};
  cyclic.self = cyclic;
  assert.equal(sanitizeForLog(cyclic), "[unserializable]");
});

test("sanitizeForLog uses Error message", () => {
  assert.equal(sanitizeForLog(new Error("boom\nline")), "boomline");
});

test("sanitizeForLog JSON-stringifies plain objects", () => {
  assert.equal(sanitizeForLog({ a: 1 }), '{"a":1}');
});
