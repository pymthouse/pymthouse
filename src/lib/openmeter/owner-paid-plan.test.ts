import assert from "node:assert/strict";
import test from "node:test";

import {
  OWNER_PAID_PLAN_KEY,
  isOwnerPaidPlanKey,
} from "@/lib/openmeter/owner-paid-key";
import {
  ensureOwnerPaidPlanSynced,
  ownerPaidTierPlanMatchesPublished,
  ownerWalletAllowsOverageInvoicing,
  resetOwnerPaidPlanCacheForTests,
  upgradeOwnerToPaidPlan,
  OwnerPaidUpgradeError,
} from "@/lib/openmeter/owner-paid-plan";

test("isOwnerPaidPlanKey matches the platform Paid key and tier suffixes", () => {
  assert.equal(isOwnerPaidPlanKey(OWNER_PAID_PLAN_KEY), true);
  assert.equal(isOwnerPaidPlanKey("pymthouse_owner_paid"), true);
  assert.equal(isOwnerPaidPlanKey("pymthouse_owner_paid_growth"), true);
  assert.equal(isOwnerPaidPlanKey("pymthouse_owner_paid_producer"), true);
  assert.equal(isOwnerPaidPlanKey("pymthouse_owner_starter"), false);
  assert.equal(isOwnerPaidPlanKey(""), false);
  assert.equal(isOwnerPaidPlanKey(null), false);
});

test("ensureOwnerPaidPlanSynced rejects when OpenMeter is unavailable", async () => {
  resetOwnerPaidPlanCacheForTests();
  await assert.rejects(
    () => ensureOwnerPaidPlanSynced(),
    /OpenMeter is not configured/,
  );
});

test("upgradeOwnerToPaidPlan rejects when OpenMeter is unavailable", async () => {
  resetOwnerPaidPlanCacheForTests();
  await assert.rejects(
    () =>
      upgradeOwnerToPaidPlan({
        ownerUserId: "user_test",
        confirm: true,
      }),
    (err: unknown) =>
      err instanceof OwnerPaidUpgradeError &&
      err.code === "openmeter_unavailable",
  );
});

test("upgradeOwnerToPaidPlan rejects without confirm", async () => {
  resetOwnerPaidPlanCacheForTests();
  await assert.rejects(
    () =>
      upgradeOwnerToPaidPlan({
        ownerUserId: "user_test",
        confirm: false,
      }),
    (err: unknown) =>
      err instanceof OwnerPaidUpgradeError && err.code === "confirm_required",
  );
});

test("upgradeOwnerToPaidPlan rejects blank ownerUserId", async () => {
  resetOwnerPaidPlanCacheForTests();
  await assert.rejects(
    () =>
      upgradeOwnerToPaidPlan({
        ownerUserId: "   ",
        confirm: true,
      }),
    (err: unknown) =>
      err instanceof OwnerPaidUpgradeError &&
      err.code === "openmeter_unavailable",
  );
});

test("ownerWalletAllowsOverageInvoicing is false for blank owner", async () => {
  assert.equal(await ownerWalletAllowsOverageInvoicing(""), false);
  assert.equal(await ownerWalletAllowsOverageInvoicing("   "), false);
});

test("OwnerPaidUpgradeError preserves code", () => {
  const err = new OwnerPaidUpgradeError(
    "payment_method_required",
    "Add a payment method",
  );
  assert.equal(err.name, "OwnerPaidUpgradeError");
  assert.equal(err.code, "payment_method_required");
  assert.equal(err.message, "Add a payment method");
});

test("ownerPaidTierPlanMatchesPublished requires fee and included parity", () => {
  assert.equal(
    ownerPaidTierPlanMatchesPublished({
      includedUsdMicros: "5000000",
      monthlyFeeUsd: "20",
      publishedIncluded: "5000000",
      publishedFee: "20.00",
    }),
    true,
  );
  assert.equal(
    ownerPaidTierPlanMatchesPublished({
      includedUsdMicros: "5000000",
      monthlyFeeUsd: "20.00",
      publishedIncluded: "5000000",
      publishedFee: "25.00",
    }),
    false,
  );
  assert.equal(
    ownerPaidTierPlanMatchesPublished({
      includedUsdMicros: "5000000",
      monthlyFeeUsd: "20.00",
      publishedIncluded: "10000000",
      publishedFee: "20.00",
    }),
    false,
  );
  assert.equal(
    ownerPaidTierPlanMatchesPublished({
      includedUsdMicros: "5000000",
      monthlyFeeUsd: "20.00",
      publishedIncluded: "5000000",
      publishedFee: null,
    }),
    false,
  );
});
