import test from "node:test";
import assert from "node:assert/strict";
import { fiatAmountToUsdMicros } from "./amount";

test("fiatAmountToUsdMicros converts USD to micros", () => {
  assert.equal(fiatAmountToUsdMicros("USD", "25").toString(), "25000000");
  assert.equal(fiatAmountToUsdMicros("usd", "0.50").toString(), "500000");
});

test("fiatAmountToUsdMicros rejects non-USD currencies", () => {
  assert.throws(() => fiatAmountToUsdMicros("EUR", "10"), /Unsupported fiat currency/);
});
