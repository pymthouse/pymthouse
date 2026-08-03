import assert from "node:assert/strict";
import test from "node:test";

import { mergeOwnerBilling } from "@/lib/billing/owner-billing-config";

/**
 * Pure resolve precedence for the platform Owner Starter default is covered
 * together with mergeOwnerBilling: callers pass the DB/env/fallback micros as
 * `defaults.starterIncludedUsdMicros`. Direct DB tests need a live database.
 */

test("resolved owner billing prefers override over platform default micros", () => {
  const resolved = mergeOwnerBilling(
    {
      starterIncludedUsdMicros: "25000000",
      endUserCap: null,
      applicationFeeBps: null,
      note: null,
    },
    {
      starterIncludedUsdMicros: "10000000",
      endUserCap: 25,
      applicationFeeBps: 0,
    },
  );
  assert.equal(resolved.starterIncludedUsdMicros, "25000000");
  assert.equal(resolved.hasOverride, true);
});

test("without override the platform default micros win", () => {
  const resolved = mergeOwnerBilling(null, {
    starterIncludedUsdMicros: "10000000",
    endUserCap: 40,
    applicationFeeBps: 100,
  });
  assert.equal(resolved.starterIncludedUsdMicros, "10000000");
  assert.equal(resolved.endUserCap, 40);
  assert.equal(resolved.applicationFeeBps, 100);
  assert.equal(resolved.hasOverride, false);
});
