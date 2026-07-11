import assert from "node:assert/strict";
import test from "node:test";
import {
  formatUsdMicros,
  formatUsdNanos,
  formatUsdPicos,
  formatUsdMicrosDisplay,
  formatUsdNanosDisplay,
  formatUsdPicosDisplay,
} from "./format-usd";

test("formatUsdMicros shows sub-cent fees at 6 digits", () => {
  assert.equal(formatUsdMicros("15", 4), "$0");
  assert.equal(formatUsdMicros("15", 6), "$0.000015");
});

test("formatUsdNanos formats OpenMeter meter units", () => {
  assert.equal(formatUsdNanos("14873", 6), "$0.000014");
  assert.equal(formatUsdNanos("14873", 9), "$0.000014873");
});

test("formatUsdPicos formats sub-micro dust", () => {
  assert.equal(formatUsdPicos("2", 12), "$0.000000000002");
  assert.equal(formatUsdPicos("1500000", 6), "$0.000001");
});

test("formatUsdNanosDisplay adapts fraction digits", () => {
  assert.equal(formatUsdNanosDisplay("0"), "$0");
  assert.equal(formatUsdNanosDisplay("14873"), "$0.000014");
});

test("formatUsdPicosDisplay shows dust below one micro", () => {
  assert.equal(formatUsdPicosDisplay("0"), "$0");
  assert.equal(formatUsdPicosDisplay("2"), "$0.000000000002");
});

test("formatUsdMicrosDisplay uses fixed $0.00 cents for allowance UI", () => {
  assert.equal(formatUsdMicrosDisplay("5000000"), "$5.00");
  assert.equal(formatUsdMicrosDisplay("0"), "$0.00");
  assert.equal(formatUsdMicrosDisplay("5250000"), "$5.25");
  assert.equal(formatUsdMicrosDisplay("15"), "$0.00");
});
