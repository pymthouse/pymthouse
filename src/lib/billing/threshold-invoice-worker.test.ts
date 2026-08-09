import assert from "node:assert/strict";
import { test } from "node:test";

import {
  gatheringInvoiceMeetsThreshold,
  gatheringTotalUsdMicros,
} from "@/lib/billing/threshold-invoice-worker";

test("gatheringTotalUsdMicros covers edge branches", () => {
  assert.equal(gatheringTotalUsdMicros(undefined), null);
  assert.equal(gatheringTotalUsdMicros(Number.NaN), null);
  assert.equal(gatheringTotalUsdMicros(Number.POSITIVE_INFINITY), null);
  assert.equal(gatheringTotalUsdMicros("   "), null);
  assert.equal(gatheringTotalUsdMicros("12.34"), 12_340_000n);
  assert.equal(gatheringTotalUsdMicros("10"), 10_000_000n);
  assert.equal(gatheringTotalUsdMicros({} as unknown as string), null);
  assert.equal(gatheringTotalUsdMicros(true as unknown as string), null);
});

test("gatheringInvoiceMeetsThreshold ignores unparsable totals", () => {
  assert.equal(
    gatheringInvoiceMeetsThreshold(["nope", null, "3.00"], 5_000_000n),
    false,
  );
  assert.equal(
    gatheringInvoiceMeetsThreshold(["nope", "5.00"], 5_000_000n),
    true,
  );
});
