import assert from "node:assert/strict";
import test from "node:test";
import {
  formatUsdMicros,
  formatUsdNanos,
  formatUsdMicrosDisplay,
  formatUsdNanosDisplay,
} from "./format-usd";

test("formatUsdMicros shows sub-cent fees at 6 digits", () => {
  assert.equal(formatUsdMicros("15", 4), "$0");
  assert.equal(formatUsdMicros("15", 6), "$0.000015");
});

test("formatUsdNanos formats OpenMeter meter units", () => {
  assert.equal(formatUsdNanos("14873", 6), "$0.000014");
  assert.equal(formatUsdNanos("14873", 9), "$0.000014873");
});

test("formatUsdNanosDisplay adapts fraction digits", () => {
  assert.equal(formatUsdNanosDisplay("0"), "$0");
  assert.equal(formatUsdNanosDisplay("14873"), "$0.000014");
});

test("formatUsdMicrosDisplay keeps allowance micros semantics", () => {
  assert.equal(formatUsdMicrosDisplay("5000000"), "$5");
  assert.equal(formatUsdMicrosDisplay("15"), "$0.000015");
});
