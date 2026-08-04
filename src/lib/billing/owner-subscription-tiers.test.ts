import assert from "node:assert/strict";
import test from "node:test";

import { parseOwnerTierMonthlyFeeUsd } from "@/lib/billing/owner-subscription-tiers";
import { isValidOwnerPaidTierKey } from "@/lib/openmeter/owner-paid-key";

test("parseOwnerTierMonthlyFeeUsd accepts positive decimals", () => {
  assert.equal(parseOwnerTierMonthlyFeeUsd("20"), "20.00");
  assert.equal(parseOwnerTierMonthlyFeeUsd("20.5"), "20.50");
  assert.equal(parseOwnerTierMonthlyFeeUsd("0"), null);
  assert.equal(parseOwnerTierMonthlyFeeUsd("-1"), null);
  assert.equal(parseOwnerTierMonthlyFeeUsd("nope"), null);
});

test("isValidOwnerPaidTierKey allows base and slug keys", () => {
  assert.equal(isValidOwnerPaidTierKey("pymthouse_owner_paid"), true);
  assert.equal(isValidOwnerPaidTierKey("pymthouse_owner_paid_growth"), true);
  assert.equal(isValidOwnerPaidTierKey("pymthouse_owner_paid_pro_plus"), true);
  assert.equal(isValidOwnerPaidTierKey("pymthouse_owner_starter"), false);
  assert.equal(isValidOwnerPaidTierKey("owner_paid"), false);
});
