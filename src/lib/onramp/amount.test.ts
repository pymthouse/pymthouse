import test from "node:test";
import assert from "node:assert/strict";
import { fiatAmountToUsdMicros } from "./amount";

test("fiatAmountToUsdMicros converts USD to micros", () => {
  assert.equal(fiatAmountToUsdMicros("USD", "25").toString(), "25000000");
  assert.equal(fiatAmountToUsdMicros("usd", "0.50").toString(), "500000");
  assert.equal(fiatAmountToUsdMicros("USD", "0.000001").toString(), "1");
});

test("fiatAmountToUsdMicros rejects non-USD currencies", () => {
  assert.throws(() => fiatAmountToUsdMicros("EUR", "10"), /Unsupported fiat currency/);
});

test("fiatAmountToUsdMicros rejects malformed and zero amounts", () => {
  assert.throws(() => fiatAmountToUsdMicros("USD", "25 USD"), /positive decimal/);
  assert.throws(() => fiatAmountToUsdMicros("USD", "0"), /positive number/);
  assert.throws(() => fiatAmountToUsdMicros("USD", "0.0000001"), /decimal places/);
  assert.throws(() => fiatAmountToUsdMicros("USD", "-1"), /positive decimal/);
});
