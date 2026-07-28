import assert from "node:assert/strict";
import { test } from "node:test";
import {
  billingCycleToOpenMeterCadence,
  normalizePlanBillingCycle,
  parsePlanBillingCycleInput,
} from "./billing-cycle";

test("billingCycleToOpenMeterCadence maps known cycles", () => {
  assert.equal(billingCycleToOpenMeterCadence("daily"), "P1D");
  assert.equal(billingCycleToOpenMeterCadence("weekly"), "P1W");
  assert.equal(billingCycleToOpenMeterCadence("monthly"), "P1M");
  assert.equal(billingCycleToOpenMeterCadence("MONTHLY"), "P1M");
});

test("billingCycleToOpenMeterCadence falls back to monthly", () => {
  assert.equal(billingCycleToOpenMeterCadence(undefined), "P1M");
  assert.equal(billingCycleToOpenMeterCadence("quarterly"), "P1M");
});

test("normalizePlanBillingCycle lowercases valid values", () => {
  assert.equal(normalizePlanBillingCycle(" Weekly "), "weekly");
});

test("parsePlanBillingCycleInput validates", () => {
  assert.deepEqual(parsePlanBillingCycleInput(undefined), {
    ok: true,
    value: "monthly",
  });
  assert.deepEqual(parsePlanBillingCycleInput("daily"), {
    ok: true,
    value: "daily",
  });
  const bad = parsePlanBillingCycleInput("yearly");
  assert.equal(bad.ok, false);
  if (!bad.ok) {
    assert.match(bad.error, /daily, weekly, monthly/);
  }
});
