import assert from "node:assert/strict";
import test from "node:test";

import { buildBillingCycleSummary, resolveBillingPeriod } from "./app-billing";

test("resolveBillingPeriod prefers subscription bounds", () => {
  const period = resolveBillingPeriod({
    currentPeriodStart: "2026-05-01T00:00:00.000Z",
    currentPeriodEnd: "2026-05-31T23:59:59.999Z",
    now: new Date("2026-05-16T12:00:00.000Z"),
  });
  assert.deepEqual(period, {
    periodStart: "2026-05-01T00:00:00.000Z",
    periodEnd: "2026-05-31T23:59:59.999Z",
  });
});

test("buildBillingCycleSummary computes overage and timeline data", () => {
  const summary = buildBillingCycleSummary({
    usageRows: [
      {
        id: "u1",
        createdAt: "2026-05-02T10:00:00.000Z",
        fee: "10",
        units: "7",
      },
      {
        id: "u2",
        createdAt: "2026-05-02T12:00:00.000Z",
        fee: "5",
        units: "8",
      },
    ],
    billingEvents: [
      {
        pipeline: "image",
        modelId: "m1",
        networkFeeWei: "10",
        networkFeeUsdMicros: "100",
        platformFeeUsdMicros: "20",
        ownerChargeWei: "12",
        ownerChargeUsdMicros: "120",
        endUserBillableUsdMicros: "140",
      },
    ],
    periodStart: "2026-05-01T00:00:00.000Z",
    periodEnd: "2026-05-03T23:59:59.999Z",
    plan: {
      type: "subscription",
      includedUnits: "10",
      overageRateWei: "2",
      includedUsdMicros: "200",
    },
  });

  assert.equal(summary.usage.requestCount, 2);
  assert.equal(summary.usage.totalUnits, "15");
  assert.equal(summary.overage.overageUnits, "5");
  assert.equal(summary.overage.overageWei, "10");
  assert.equal(summary.timeline.length, 3);
  assert.equal(summary.retail.remainingIncludedUsdMicros, "60");
  assert.equal(summary.byPipelineModel.length, 1);
});
