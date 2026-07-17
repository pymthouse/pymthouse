import assert from "node:assert/strict";
import test from "node:test";
import {
  formatUsdMicrosDisplay,
  formatUsdMicrosString,
  hasPositiveUsdMicrosBalance,
  normalizeUsdCentsDisplay,
  parseUsdMicrosString,
  sanitizeUsdCentsInput,
  usdCentsDisplayToMicros,
  usdMicrosToCentsDisplay,
} from "./format-usd-micros";

test("formatUsdMicrosString shows sub-$0.0001 fees as a floor label", () => {
  assert.equal(formatUsdMicrosString("15", 4), "< $0.0001");
  assert.equal(formatUsdMicrosString("34", 6), "< $0.0001");
  assert.equal(formatUsdMicrosString("99", 4), "< $0.0001");
  assert.equal(formatUsdMicrosString("-15", 4), "> -$0.0001");
});

test("formatUsdMicrosString shows $0.0001 and above exactly", () => {
  assert.equal(formatUsdMicrosString("100", 4), "$0.0001");
  assert.equal(formatUsdMicrosString("612", 4), "$0.000612");
  assert.equal(formatUsdMicrosString("1000000", 4), "$1");
  assert.equal(formatUsdMicrosString("0", 4), null);
});

test("hasPositiveUsdMicrosBalance matches mint gate micros floor", () => {
  assert.equal(hasPositiveUsdMicrosBalance("0"), false);
  assert.equal(hasPositiveUsdMicrosBalance("1"), true);
  assert.equal(hasPositiveUsdMicrosBalance("34"), true);
  assert.equal(hasPositiveUsdMicrosBalance(null), false);
  assert.equal(parseUsdMicrosString("34"), 34n);
});

test("formatUsdMicrosDisplay uses fixed $0.00 cents for allowance UI", () => {
  assert.equal(formatUsdMicrosDisplay("5000000"), "$5.00");
  assert.equal(formatUsdMicrosDisplay("0"), "$0.00");
  assert.equal(formatUsdMicrosDisplay("5250000"), "$5.25");
  assert.equal(formatUsdMicrosDisplay("15"), "$0.00");
});

test("sanitizeUsdCentsInput keeps only dollars and cents", () => {
  assert.equal(sanitizeUsdCentsInput("$5.00"), "5.00");
  assert.equal(sanitizeUsdCentsInput("5.999"), "5.99");
  assert.equal(sanitizeUsdCentsInput("12.3.4"), "12.34");
  assert.equal(sanitizeUsdCentsInput("abc"), "");
});

test("usd micros ↔ cents display round-trips at cent precision", () => {
  assert.equal(usdMicrosToCentsDisplay("5000000"), "5.00");
  assert.equal(usdMicrosToCentsDisplay("5250000"), "5.25");
  assert.equal(usdCentsDisplayToMicros("5"), "5000000");
  assert.equal(usdCentsDisplayToMicros("5.5"), "5500000");
  assert.equal(usdCentsDisplayToMicros("5.00"), "5000000");
  assert.equal(usdCentsDisplayToMicros("5."), "5000000");
  assert.equal(usdCentsDisplayToMicros(""), null);
  assert.equal(usdCentsDisplayToMicros("5.999"), null);
  assert.equal(normalizeUsdCentsDisplay("5"), "5.00");
  assert.equal(normalizeUsdCentsDisplay("5.5"), "5.50");
  assert.equal(normalizeUsdCentsDisplay("5."), "5.00");
});
