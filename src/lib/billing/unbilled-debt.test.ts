import assert from "node:assert/strict";
import test from "node:test";

import { gatheringTotalUsdMicros } from "@/lib/billing/unbilled-debt";
import {
  normalizeStripeCurrency,
  resolveAppBillingCurrency,
  __setResolveAppBillingCurrencyForTests,
} from "@/lib/stripe/topup-ownership";

test("gatheringTotalUsdMicros parses dollars, micros strings, and rejects garbage", () => {
  assert.equal(gatheringTotalUsdMicros(null), null);
  assert.equal(gatheringTotalUsdMicros(undefined), null);
  assert.equal(gatheringTotalUsdMicros({}), null);
  assert.equal(gatheringTotalUsdMicros(Number.NaN), null);
  assert.equal(gatheringTotalUsdMicros(Number.POSITIVE_INFINITY), null);
  assert.equal(gatheringTotalUsdMicros(1.25), 1_250_000n);
  assert.equal(gatheringTotalUsdMicros(1.5), 1_500_000n);
  assert.equal(gatheringTotalUsdMicros("2.50"), 2_500_000n);
  assert.equal(gatheringTotalUsdMicros("5.00"), 5_000_000n);
  assert.equal(gatheringTotalUsdMicros("12.34"), 12_340_000n);
  assert.equal(gatheringTotalUsdMicros("10"), 10_000_000n);
  assert.equal(gatheringTotalUsdMicros("   "), null);
  assert.equal(gatheringTotalUsdMicros(""), null);
  // Long integer strings are treated as micros already.
  assert.equal(gatheringTotalUsdMicros("123456789"), 123_456_789n);
  assert.equal(gatheringTotalUsdMicros("100000000"), 100_000_000n);
  assert.equal(gatheringTotalUsdMicros("not-a-number"), null);
  assert.equal(gatheringTotalUsdMicros({} as unknown as string), null);
  assert.equal(gatheringTotalUsdMicros(true as unknown as string), null);
});

test("normalizeStripeCurrency lowercases and rejects blanks", () => {
  assert.equal(normalizeStripeCurrency("USD"), "usd");
  assert.equal(normalizeStripeCurrency(" Eur "), "eur");
  assert.equal(normalizeStripeCurrency(""), null);
  assert.equal(normalizeStripeCurrency("   "), null);
  assert.equal(normalizeStripeCurrency(null), null);
  assert.equal(normalizeStripeCurrency(1), null);
});

test("resolveAppBillingCurrency uses test override and defaults", async (t) => {
  t.after(() => {
    __setResolveAppBillingCurrencyForTests(null);
  });

  __setResolveAppBillingCurrencyForTests(async () => "eur");
  assert.equal(await resolveAppBillingCurrency("app_any"), "eur");

  __setResolveAppBillingCurrencyForTests(async () => "USD");
  assert.equal(await resolveAppBillingCurrency("app_any"), "USD");
});
