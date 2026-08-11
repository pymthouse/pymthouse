import assert from "node:assert/strict";
import test from "node:test";

import {
  gatheringTotalUsdMicros,
  netBillableMeterDebtUsdMicros,
} from "@/lib/billing/unbilled-debt";

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
  // Long integer strings are treated as micros (OpenMeter sometimes returns micros).
  assert.equal(gatheringTotalUsdMicros("123456789"), 123_456_789n);
  assert.equal(gatheringTotalUsdMicros("100000000"), 100_000_000n);
  assert.equal(gatheringTotalUsdMicros("not-a-number"), null);
  assert.equal(gatheringTotalUsdMicros({} as unknown as string), null);
  assert.equal(gatheringTotalUsdMicros(true as unknown as string), null);
});

test("netBillableMeterDebtUsdMicros subtracts remaining included usage", () => {
  assert.equal(
    netBillableMeterDebtUsdMicros({
      meterUsdMicros: 2_040_000n,
      remainingIncludedUsdMicros: 5_000_000n,
    }),
    0n,
  );
  assert.equal(
    netBillableMeterDebtUsdMicros({
      meterUsdMicros: 7_000_000n,
      remainingIncludedUsdMicros: 5_000_000n,
    }),
    2_000_000n,
  );
  assert.equal(
    netBillableMeterDebtUsdMicros({
      meterUsdMicros: 1_000_000n,
      remainingIncludedUsdMicros: 0n,
    }),
    1_000_000n,
  );
});
