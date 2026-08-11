import assert from "node:assert/strict";
import test from "node:test";

/**
 * Validation for the platform billing PATCH body — mirrors the route's parse
 * so invalid micros are rejected without needing a Next request scope / session.
 */
function parseOwnerStarterMicros(raw: unknown): string | null {
  if (typeof raw === "string") {
    const trimmed = raw.trim();
    return /^\d+$/.test(trimmed) ? trimmed : null;
  }
  if (typeof raw === "number" && Number.isFinite(raw)) {
    const truncated = String(Math.trunc(raw));
    return /^\d+$/.test(truncated) ? truncated : null;
  }
  return null;
}

test("platform PATCH rejects missing or malformed micros", () => {
  assert.equal(parseOwnerStarterMicros(undefined), null);
  assert.equal(parseOwnerStarterMicros({}), null);
  assert.equal(parseOwnerStarterMicros("abc"), null);
  assert.equal(parseOwnerStarterMicros("-1"), null);
  assert.equal(parseOwnerStarterMicros(""), null);
});

test("platform PATCH accepts integer micros strings and numbers", () => {
  assert.equal(parseOwnerStarterMicros("5000000"), "5000000");
  assert.equal(parseOwnerStarterMicros(" 10000000 "), "10000000");
  assert.equal(parseOwnerStarterMicros(7500000), "7500000");
});
