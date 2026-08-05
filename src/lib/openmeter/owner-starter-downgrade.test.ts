import assert from "node:assert/strict";
import test from "node:test";

import {
  OwnerStarterDowngradeError,
  deriveOwnerPendingDowngrade,
  downgradeOwnerToStarterPlan,
  ownerStarterDowngradeHttpStatus,
} from "@/lib/openmeter/owner-starter-downgrade";

test("downgradeOwnerToStarterPlan rejects without confirm", async () => {
  await assert.rejects(
    () =>
      downgradeOwnerToStarterPlan({
        ownerUserId: "user_test",
        confirm: false,
      }),
    (err: unknown) =>
      err instanceof OwnerStarterDowngradeError &&
      err.code === "confirm_required",
  );
});

test("downgradeOwnerToStarterPlan rejects when OpenMeter is unavailable", async () => {
  await assert.rejects(
    () =>
      downgradeOwnerToStarterPlan({
        ownerUserId: "user_test",
        confirm: true,
      }),
    (err: unknown) =>
      err instanceof OwnerStarterDowngradeError &&
      err.code === "openmeter_unavailable",
  );
});

test("OwnerStarterDowngradeError preserves code", () => {
  const err = new OwnerStarterDowngradeError(
    "not_on_paid",
    "Downgrade is only available on an Owner Paid plan",
  );
  assert.equal(err.name, "OwnerStarterDowngradeError");
  assert.equal(err.code, "not_on_paid");
  assert.equal(err.message, "Downgrade is only available on an Owner Paid plan");
});

test("ownerStarterDowngradeHttpStatus maps known codes", () => {
  assert.equal(ownerStarterDowngradeHttpStatus("confirm_required"), 400);
  assert.equal(ownerStarterDowngradeHttpStatus("not_on_paid"), 404);
  assert.equal(ownerStarterDowngradeHttpStatus("no_subscription"), 404);
  assert.equal(ownerStarterDowngradeHttpStatus("openmeter_unavailable"), 503);
  assert.equal(ownerStarterDowngradeHttpStatus("downgrade_failed"), 502);
});

test("deriveOwnerPendingDowngrade surfaces scheduled Starter beside active Paid", () => {
  const { displaySubscriptions, pendingDowngrade } = deriveOwnerPendingDowngrade({
    subscriptions: [
      {
        appPublicClientId: null,
        openMeterPlanKey: "pymthouse_owner_paid_producer",
        planName: "Producer",
        status: "active",
        activeTo: "2026-09-01T00:00:00.000Z",
      },
      {
        appPublicClientId: null,
        openMeterPlanKey: "pymthouse_owner_starter",
        planName: "Owner Sandbox Starter",
        status: "scheduled",
        activeFrom: "2026-09-01T00:00:00.000Z",
      },
      {
        appPublicClientId: "app_x",
        openMeterPlanKey: "app_plan",
        planName: "App plan",
        status: "active",
      },
    ],
    starterPlanName: "Sandbox Starter",
  });

  assert.deepEqual(pendingDowngrade, {
    planName: "Sandbox Starter",
    planKey: "pymthouse_owner_starter",
    effectiveAt: "2026-09-01T00:00:00.000Z",
    currentPlanName: "Producer",
  });
  assert.equal(displaySubscriptions.length, 2);
  assert.equal(
    displaySubscriptions.some((row) =>
      (row.openMeterPlanKey || "").includes("starter"),
    ),
    false,
  );
  assert.equal(
    displaySubscriptions.some((row) => row.appPublicClientId === "app_x"),
    true,
  );
});

test("deriveOwnerPendingDowngrade is null without scheduled Starter", () => {
  const { displaySubscriptions, pendingDowngrade } = deriveOwnerPendingDowngrade({
    subscriptions: [
      {
        appPublicClientId: null,
        openMeterPlanKey: "pymthouse_owner_paid_producer",
        planName: "Producer",
        status: "active",
      },
    ],
    starterPlanName: "Sandbox Starter",
  });
  assert.equal(pendingDowngrade, null);
  assert.equal(displaySubscriptions.length, 1);
});
