import assert from "node:assert/strict";
import test from "node:test";

import {
  OWNER_PAID_PLAN_KEY,
  isOwnerPaidPlanKey,
} from "@/lib/openmeter/owner-paid-key";
import {
  ensureOwnerPaidPlanSynced,
  ownerWalletAllowsOverageInvoicing,
  resetOwnerPaidPlanCacheForTests,
  upgradeOwnerToPaidPlan,
  OwnerPaidUpgradeError,
} from "@/lib/openmeter/owner-paid-plan";

test("isOwnerPaidPlanKey matches the platform Paid key and tier suffixes", () => {
  assert.equal(isOwnerPaidPlanKey(OWNER_PAID_PLAN_KEY), true);
  assert.equal(isOwnerPaidPlanKey("pymthouse_owner_paid"), true);
  assert.equal(isOwnerPaidPlanKey("pymthouse_owner_paid_growth"), true);
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
