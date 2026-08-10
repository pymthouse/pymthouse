import assert from "node:assert/strict";
import test from "node:test";

import {
  formatUsdMicrosForDisplay,
  isPayPerUsePlanType,
  parseChargeThresholdUsdInput,
  PAY_PER_USE_NOMINAL_BILLING_CYCLE,
  resolvedPayPerUseBehavior,
} from "@/lib/billing/pay-per-use-threshold";

test("isPayPerUsePlanType matches only the usage plan type", () => {
  assert.equal(isPayPerUsePlanType("usage"), true);
  assert.equal(isPayPerUsePlanType(" Usage "), true);
  assert.equal(isPayPerUsePlanType("subscription"), false);
  assert.equal(isPayPerUsePlanType("free"), false);
  assert.equal(isPayPerUsePlanType(null), false);
  assert.equal(isPayPerUsePlanType(undefined), false);
});

test("nominal billing cycle stays a valid plan cycle for Konnect", () => {
  assert.equal(PAY_PER_USE_NOMINAL_BILLING_CYCLE, "monthly");
});

test("parseChargeThresholdUsdInput converts dollars to USD micros", () => {
  assert.deepEqual(parseChargeThresholdUsdInput("10"), { ok: true, value: "10000000" });
  assert.deepEqual(parseChargeThresholdUsdInput("10.00"), { ok: true, value: "10000000" });
  assert.deepEqual(parseChargeThresholdUsdInput("0.5"), { ok: true, value: "500000" });
  assert.deepEqual(parseChargeThresholdUsdInput("2.25"), { ok: true, value: "2250000" });
  assert.deepEqual(parseChargeThresholdUsdInput(25), { ok: true, value: "25000000" });
});

test("parseChargeThresholdUsdInput treats empty input as clearing", () => {
  assert.deepEqual(parseChargeThresholdUsdInput(undefined), { ok: true, value: null });
  assert.deepEqual(parseChargeThresholdUsdInput(null), { ok: true, value: null });
  assert.deepEqual(parseChargeThresholdUsdInput(""), { ok: true, value: null });
  assert.deepEqual(parseChargeThresholdUsdInput("   "), { ok: true, value: null });
});

test("parseChargeThresholdUsdInput rejects invalid amounts", () => {
  for (const bad of ["0", "0.00", "-5", "1.234", "abc", "1e3", "$10", "10,000"]) {
    const result = parseChargeThresholdUsdInput(bad);
    assert.equal(result.ok, false, `expected rejection for ${JSON.stringify(bad)}`);
  }
  assert.equal(parseChargeThresholdUsdInput(Number.NaN).ok, false);
  assert.equal(parseChargeThresholdUsdInput({}).ok, false);
  assert.equal(parseChargeThresholdUsdInput(true).ok, false);
  // 7-digit dollars parse but exceed the $1,000,000 cap
  assert.equal(parseChargeThresholdUsdInput("9999999").ok, false);
  // Exact dollar cap is allowed; cents past the cap must not slip through
  // a dollars-only comparison (1_000_000.01 → dollars === MAX).
  assert.deepEqual(parseChargeThresholdUsdInput("1000000"), {
    ok: true,
    value: "1000000000000",
  });
  assert.equal(parseChargeThresholdUsdInput("1000000.01").ok, false);
});

test("formatUsdMicrosForDisplay renders at least two decimals", () => {
  assert.equal(formatUsdMicrosForDisplay("10000000"), "10.00");
  assert.equal(formatUsdMicrosForDisplay("2250000"), "2.25");
  assert.equal(formatUsdMicrosForDisplay("500000"), "0.50");
  assert.equal(formatUsdMicrosForDisplay("1234500"), "1.2345");
  assert.equal(formatUsdMicrosForDisplay("garbage"), "0.00");
});

test("resolvedPayPerUseBehavior describes credits then automatic invoicing", () => {
  const behavior = resolvedPayPerUseBehavior();
  assert.match(behavior, /prepaid credits first/);
  assert.match(behavior, /invoiced automatically as it accrues/);
});

test("resolvedPayPerUseBehavior promises no charge cadence the plan cannot keep", () => {
  const behavior = resolvedPayPerUseBehavior();
  // Collection timing is app-scoped (overage limit + lead window), so plan copy
  // must not imply a per-plan trigger.
  assert.doesNotMatch(behavior, /auto-debit|charged at every|threshold/i);
});

test("threshold round-trips through parse and format", () => {
  const parsed = parseChargeThresholdUsdInput("42.75");
  assert.ok(parsed.ok);
  assert.equal(formatUsdMicrosForDisplay(parsed.value as string), "42.75");
});
