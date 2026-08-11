import assert from "node:assert/strict";
import test from "node:test";

import {
  ensureOwnerPaidPlanSynced,
  isKonnectScheduledChangeForbidden,
  listScheduledOwnerWalletSubscriptionIds,
  ownerPaidTierPlanMatchesPublished,
  ownerWalletAllowsOverageInvoicing,
  pickLiveOwnerWalletSubscription,
  resetOwnerPaidPlanCacheForTests,
  upgradeOwnerToPaidPlan,
  OwnerPaidUpgradeError,
} from "@/lib/openmeter/owner-paid-plan";

test("pickLiveOwnerWalletSubscription ignores scheduled-only wallets", () => {
  const listed = [
    {
      id: "sub_old",
      status: "canceled",
      planKey: "pymthouse_owner_paid_producer",
      planId: "plan_p",
      customerId: "c1",
      activeFrom: null,
      activeTo: null,
    },
    {
      id: "sub_sched",
      status: "scheduled",
      planKey: "pymthouse_owner_starter",
      planId: "plan_s",
      customerId: "c1",
      activeFrom: null,
      activeTo: null,
    },
  ];
  assert.equal(pickLiveOwnerWalletSubscription(listed), null);
  assert.deepEqual(listScheduledOwnerWalletSubscriptionIds(listed), [
    "sub_sched",
  ]);
  assert.equal(
    isKonnectScheduledChangeForbidden(
      new Error(
        'Konnect subscription-change API failed (403): {"detail":"forbidden error: transition cancel in state scheduled not allowed"}',
      ),
    ),
    true,
  );
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

test("upgradeOwnerToPaidPlan rejects when OpenMeter is unavailable before blank-id check", async () => {
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
