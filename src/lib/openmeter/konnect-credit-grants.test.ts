import assert from "node:assert/strict";
import test from "node:test";
import {
  usdAmountToUsdMicros,
  usdMicrosToUsdAmount,
} from "./konnect-credit-grants";

test("usdMicrosToUsdAmount formats whole and fractional dollars", () => {
  assert.equal(usdMicrosToUsdAmount(25_000_000n), "25");
  assert.equal(usdMicrosToUsdAmount(500_000n), "0.5");
  assert.equal(usdMicrosToUsdAmount(1_250_000n), "1.25");
});

test("usdAmountToUsdMicros parses Konnect balance strings", () => {
  assert.equal(usdAmountToUsdMicros("25").toString(), "25000000");
  assert.equal(usdAmountToUsdMicros("25.00").toString(), "25000000");
  assert.equal(usdAmountToUsdMicros("0.5").toString(), "500000");
});
