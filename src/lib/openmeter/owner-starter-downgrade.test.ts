import assert from "node:assert/strict";
import test from "node:test";

import {
  OwnerPaidResumeError,
  OwnerStarterDowngradeError,
  deriveOwnerPendingDowngrade,
  downgradeOwnerToStarterPlan,
  ownerPaidResumeHttpStatus,
  ownerStarterDowngradeHttpStatus,
  resolveOwnerPaidResumeTarget,
  resumeOwnerPaidAfterScheduledDowngrade,
} from "@/lib/openmeter/owner-starter-downgrade";
import type { OpenMeterSubscriptionView } from "@/lib/openmeter/subscription-read";

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
  const env = process.env as { NODE_ENV?: string; OPENMETER_TEST_LIVE?: string };
  const prevNodeEnv = env.NODE_ENV;
  const prevLive = env.OPENMETER_TEST_LIVE;
  env.NODE_ENV = "test";
  delete env.OPENMETER_TEST_LIVE;
  try {
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
  } finally {
    if (prevNodeEnv === undefined) {
      delete env.NODE_ENV;
    } else {
      env.NODE_ENV = prevNodeEnv;
    }
    if (prevLive === undefined) {
      delete env.OPENMETER_TEST_LIVE;
    } else {
      env.OPENMETER_TEST_LIVE = prevLive;
    }
  }
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
    resumeBlocked: false,
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

test("resolveOwnerPaidResumeTarget needs paid + scheduled Starter", () => {
  const withBoth: OpenMeterSubscriptionView[] = [
    {
      id: "sub_paid",
      status: "active",
      customerId: "cust_1",
      planKey: "pymthouse_owner_paid_producer",
      planId: "plan_paid",
      activeFrom: null,
      activeTo: "2026-09-01T00:00:00.000Z",
    },
    {
      id: "sub_starter",
      status: "scheduled",
      customerId: "cust_1",
      planKey: "pymthouse_owner_starter",
      planId: "plan_starter",
      activeFrom: "2026-09-01T00:00:00.000Z",
      activeTo: null,
    },
  ];
  assert.deepEqual(resolveOwnerPaidResumeTarget(withBoth), {
    subscriptionId: "sub_paid",
    planKey: "pymthouse_owner_paid_producer",
    scheduledStarterId: "sub_starter",
  });
  assert.equal(
    resolveOwnerPaidResumeTarget(withBoth.slice(0, 1)),
    null,
  );
});

test("resolveOwnerPaidResumeTarget accepts cancel-at-period-end Paid", () => {
  const canceledOnly: OpenMeterSubscriptionView[] = [
    {
      id: "sub_paid",
      status: "canceled",
      customerId: "cust_1",
      planKey: "pymthouse_owner_paid_producer",
      planId: "plan_paid",
      activeFrom: null,
      activeTo: "2026-09-01T00:00:00.000Z",
    },
  ];
  assert.deepEqual(resolveOwnerPaidResumeTarget(canceledOnly), {
    subscriptionId: "sub_paid",
    planKey: "pymthouse_owner_paid_producer",
    scheduledStarterId: null,
  });
});

test("deriveOwnerPendingDowngrade surfaces cancel-at-period-end Paid", () => {
  const { displaySubscriptions, pendingDowngrade } = deriveOwnerPendingDowngrade({
    subscriptions: [
      {
        appPublicClientId: null,
        openMeterPlanKey: "pymthouse_owner_paid_producer",
        planName: "Producer",
        status: "canceled",
        activeTo: "2026-09-01T00:00:00.000Z",
      },
    ],
    starterPlanName: "Sandbox Starter",
  });
  assert.deepEqual(pendingDowngrade, {
    planName: "Sandbox Starter",
    planKey: "pymthouse_owner_starter",
    effectiveAt: "2026-09-01T00:00:00.000Z",
    currentPlanName: "Producer",
    resumeBlocked: false,
  });
  assert.equal(displaySubscriptions.length, 1);
});

test("resumeOwnerPaidAfterScheduledDowngrade rejects without confirm", async () => {
  await assert.rejects(
    () =>
      resumeOwnerPaidAfterScheduledDowngrade({
        ownerUserId: "user_test",
        confirm: false,
      }),
    (err: unknown) =>
      err instanceof OwnerPaidResumeError && err.code === "confirm_required",
  );
});

test("ownerPaidResumeHttpStatus maps known codes", () => {
  assert.equal(ownerPaidResumeHttpStatus("confirm_required"), 400);
  assert.equal(ownerPaidResumeHttpStatus("nothing_to_resume"), 404);
  assert.equal(ownerPaidResumeHttpStatus("openmeter_unavailable"), 503);
  assert.equal(ownerPaidResumeHttpStatus("resume_failed"), 502);
});
