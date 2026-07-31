import assert from "node:assert/strict";
import test from "node:test";

import {
  buildCostWaterfall,
  formatPaymentMethodLabel,
} from "@/lib/billing/cost-waterfall";

/** The invariant the billing page depends on: the steps must sum to the total. */
function assertReconciles(waterfall: ReturnType<typeof buildCostWaterfall>) {
  const sum =
    BigInt(waterfall.plan.appliedUsdMicros) +
    BigInt(waterfall.credits.appliedUsdMicros) +
    BigInt(waterfall.card.appliedUsdMicros);
  assert.equal(
    sum.toString(),
    waterfall.usedUsdMicros,
    "waterfall steps must sum to total usage",
  );
}

test("usage inside the plan allowance is fully covered by the plan", () => {
  // The reported case: $0.655482 used against a $5.00 allowance, $25 credits.
  const waterfall = buildCostWaterfall({
    usedUsdMicros: "655482",
    planIncludedUsdMicros: "5000000",
    creditBalanceUsdMicros: "25000000",
  });

  assert.equal(waterfall.plan.appliedUsdMicros, "655482");
  assert.equal(waterfall.plan.remainingUsdMicros, "4344518");
  assert.equal(waterfall.credits.appliedUsdMicros, "0");
  assert.equal(waterfall.credits.remainingUsdMicros, "25000000");
  assert.equal(waterfall.card.appliedUsdMicros, "0");
  assertReconciles(waterfall);
});

test("overage past the allowance burns prepaid credits before the card", () => {
  const waterfall = buildCostWaterfall({
    usedUsdMicros: "7000000",
    planIncludedUsdMicros: "5000000",
    creditBalanceUsdMicros: "25000000",
  });

  assert.equal(waterfall.plan.appliedUsdMicros, "5000000");
  assert.equal(waterfall.plan.remainingUsdMicros, "0");
  assert.equal(waterfall.credits.appliedUsdMicros, "2000000");
  assert.equal(waterfall.credits.remainingUsdMicros, "23000000");
  assert.equal(waterfall.card.appliedUsdMicros, "0");
  assertReconciles(waterfall);
});

test("spend beyond allowance and credits falls through to the card", () => {
  const waterfall = buildCostWaterfall({
    usedUsdMicros: "40000000",
    planIncludedUsdMicros: "5000000",
    creditBalanceUsdMicros: "25000000",
  });

  assert.equal(waterfall.plan.appliedUsdMicros, "5000000");
  assert.equal(waterfall.credits.appliedUsdMicros, "25000000");
  assert.equal(waterfall.credits.remainingUsdMicros, "0");
  assert.equal(waterfall.card.appliedUsdMicros, "10000000");
  assertReconciles(waterfall);
});

test("pay-per-use with no plan allowance settles on credits then card", () => {
  const waterfall = buildCostWaterfall({
    usedUsdMicros: "3000000",
    planIncludedUsdMicros: null,
    creditBalanceUsdMicros: "1000000",
  });

  assert.equal(waterfall.hasPlanAllowance, false);
  assert.equal(waterfall.plan.appliedUsdMicros, "0");
  assert.equal(waterfall.plan.remainingUsdMicros, null);
  assert.equal(waterfall.credits.appliedUsdMicros, "1000000");
  assert.equal(waterfall.card.appliedUsdMicros, "2000000");
  assertReconciles(waterfall);
});

test("zero usage reports zero across every step", () => {
  const waterfall = buildCostWaterfall({
    usedUsdMicros: "0",
    planIncludedUsdMicros: "5000000",
    creditBalanceUsdMicros: "25000000",
  });

  assert.equal(waterfall.usedUsdMicros, "0");
  assert.equal(waterfall.plan.appliedUsdMicros, "0");
  assert.equal(waterfall.plan.remainingUsdMicros, "5000000");
  assert.equal(waterfall.credits.appliedUsdMicros, "0");
  assert.equal(waterfall.card.appliedUsdMicros, "0");
  assertReconciles(waterfall);
});

test("missing and malformed inputs degrade to zero rather than NaN", () => {
  const waterfall = buildCostWaterfall({
    usedUsdMicros: undefined,
    planIncludedUsdMicros: "not-a-number",
    creditBalanceUsdMicros: null,
  });

  assert.equal(waterfall.usedUsdMicros, "0");
  assert.equal(waterfall.hasPlanAllowance, false);
  assertReconciles(waterfall);
});

test("waterfall reconciles at amounts beyond Number precision", () => {
  const waterfall = buildCostWaterfall({
    usedUsdMicros: "9007199254740993",
    planIncludedUsdMicros: "9007199254740991",
    creditBalanceUsdMicros: "1",
  });

  assert.equal(waterfall.plan.appliedUsdMicros, "9007199254740991");
  assert.equal(waterfall.credits.appliedUsdMicros, "1");
  assert.equal(waterfall.card.appliedUsdMicros, "1");
  assertReconciles(waterfall);
});

test("formatPaymentMethodLabel renders brand and last4", () => {
  assert.equal(
    formatPaymentMethodLabel({ brand: "visa", last4: "5094" }),
    "Visa ••5094",
  );
  assert.equal(formatPaymentMethodLabel({ brand: null, last4: "4242" }), "Card ••4242");
  assert.equal(formatPaymentMethodLabel({ brand: "amex", last4: null }), "Amex");
  assert.equal(formatPaymentMethodLabel(null), null);
});
