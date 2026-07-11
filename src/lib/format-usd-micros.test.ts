import assert from "node:assert/strict";
import test from "node:test";
import { formatUsdMicrosDisplay, formatUsdMicrosString } from "./format-usd-micros";

test("formatUsdMicrosString shows sub-cent fees at 6 digits", () => {
  assert.equal(formatUsdMicrosString("15", 4), "$0");
  assert.equal(formatUsdMicrosString("15", 6), "$0.000015");
});

test("formatUsdMicrosDisplay uses fixed $0.00 cents for allowance UI", () => {
  assert.equal(formatUsdMicrosDisplay("5000000"), "$5.00");
  assert.equal(formatUsdMicrosDisplay("0"), "$0.00");
  assert.equal(formatUsdMicrosDisplay("5250000"), "$5.25");
  assert.equal(formatUsdMicrosDisplay("15"), "$0.00");
});
