import assert from "node:assert/strict";
import test from "node:test";

import {
  includedDiscountFromOpenMeterSubscription,
  includedDiscountUsdMicrosForPlan,
} from "@/lib/openmeter/spendable-allowance";

test("includedDiscountUsdMicrosForPlan uses plan micros then starter default", () => {
  assert.equal(
    includedDiscountUsdMicrosForPlan({
      includedUsdMicros: "3000000",
      isStarterDefault: false,
    }),
    3_000_000n,
  );
  assert.equal(
    includedDiscountUsdMicrosForPlan({
      includedUsdMicros: null,
      isStarterDefault: false,
    }),
    null,
  );
});

test("includedDiscountFromOpenMeterSubscription is null when OpenMeter is unavailable", async () => {
  assert.equal(
    await includedDiscountFromOpenMeterSubscription({
      planId: "01KZ7QPPV7DV608CB6RX0YZJTA",
      planKey: "pymthouse_owner_paid_producer",
    }),
    null,
  );
});
