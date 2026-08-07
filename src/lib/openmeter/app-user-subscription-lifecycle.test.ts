import assert from "node:assert/strict";
import test from "node:test";

import {
  AppUserSubscriptionCancelError,
  AppUserSubscriptionResumeError,
  appUserSubscriptionCancelHttpStatus,
  appUserSubscriptionResumeHttpStatus,
  cancelAppUserSubscription,
  deriveAppUserPendingCancel,
  isAppUserCanceledSubscriptionStatus,
  isAppUserLiveSubscriptionStatus,
  isAppUserStarterSubscription,
  pickAppUserCancelTargets,
  resolveAppUserResumeTarget,
  resumeAppUserSubscription,
} from "@/lib/openmeter/app-user-subscription-lifecycle";
import type { OpenMeterSubscriptionView } from "@/lib/openmeter/subscription-read";

function sub(partial: Partial<OpenMeterSubscriptionView> & { id: string }): OpenMeterSubscriptionView {
  return {
    status: "active",
    customerId: "cust_1",
    planKey: "app_plan_paid",
    planId: "om_plan_paid",
    activeFrom: null,
    activeTo: null,
    ...partial,
  };
}

test("cancelAppUserSubscription rejects without confirm", async () => {
  await assert.rejects(
    () =>
      cancelAppUserSubscription({
        clientId: "app_test",
        externalUserId: "user_test",
        confirm: false,
      }),
    (err: unknown) =>
      err instanceof AppUserSubscriptionCancelError &&
      err.code === "confirm_required",
  );
});

test("resumeAppUserSubscription rejects without confirm", async () => {
  await assert.rejects(
    () =>
      resumeAppUserSubscription({
        clientId: "app_test",
        externalUserId: "user_test",
        confirm: false,
      }),
    (err: unknown) =>
      err instanceof AppUserSubscriptionResumeError &&
      err.code === "confirm_required",
  );
});

test("cancelAppUserSubscription rejects when OpenMeter is unavailable", async () => {
  const env = process.env as { NODE_ENV?: string; OPENMETER_TEST_LIVE?: string };
  const prevNodeEnv = env.NODE_ENV;
  const prevLive = env.OPENMETER_TEST_LIVE;
  env.NODE_ENV = "test";
  delete env.OPENMETER_TEST_LIVE;
  try {
    await assert.rejects(
      () =>
        cancelAppUserSubscription({
          clientId: "app_test",
          externalUserId: "user_test",
          confirm: true,
        }),
      (err: unknown) =>
        err instanceof AppUserSubscriptionCancelError &&
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

test("resumeAppUserSubscription rejects when OpenMeter is unavailable", async () => {
  const env = process.env as { NODE_ENV?: string; OPENMETER_TEST_LIVE?: string };
  const prevNodeEnv = env.NODE_ENV;
  const prevLive = env.OPENMETER_TEST_LIVE;
  env.NODE_ENV = "test";
  delete env.OPENMETER_TEST_LIVE;
  try {
    await assert.rejects(
      () =>
        resumeAppUserSubscription({
          clientId: "app_test",
          externalUserId: "user_test",
          confirm: true,
        }),
      (err: unknown) =>
        err instanceof AppUserSubscriptionResumeError &&
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

test("AppUserSubscriptionCancelError preserves code", () => {
  const err = new AppUserSubscriptionCancelError(
    "no_subscription",
    "No active subscription to cancel",
  );
  assert.equal(err.name, "AppUserSubscriptionCancelError");
  assert.equal(err.code, "no_subscription");
});

test("appUserSubscriptionCancelHttpStatus maps known codes", () => {
  assert.equal(appUserSubscriptionCancelHttpStatus("confirm_required"), 400);
  assert.equal(appUserSubscriptionCancelHttpStatus("already_scheduled"), 400);
  assert.equal(appUserSubscriptionCancelHttpStatus("no_subscription"), 404);
  assert.equal(appUserSubscriptionCancelHttpStatus("already_starter"), 404);
  assert.equal(appUserSubscriptionCancelHttpStatus("openmeter_unavailable"), 503);
  assert.equal(appUserSubscriptionCancelHttpStatus("cancel_failed"), 502);
});

test("appUserSubscriptionResumeHttpStatus maps known codes", () => {
  assert.equal(appUserSubscriptionResumeHttpStatus("confirm_required"), 400);
  assert.equal(appUserSubscriptionResumeHttpStatus("nothing_to_resume"), 404);
  assert.equal(appUserSubscriptionResumeHttpStatus("openmeter_unavailable"), 503);
  assert.equal(appUserSubscriptionResumeHttpStatus("resume_failed"), 502);
});

test("subscription status helpers classify live and canceled", () => {
  assert.equal(isAppUserLiveSubscriptionStatus("active"), true);
  assert.equal(isAppUserLiveSubscriptionStatus("trialing"), true);
  assert.equal(isAppUserLiveSubscriptionStatus("scheduled"), true);
  assert.equal(isAppUserLiveSubscriptionStatus("pending"), true);
  assert.equal(isAppUserLiveSubscriptionStatus(""), true);
  assert.equal(isAppUserLiveSubscriptionStatus("canceled"), false);
  assert.equal(isAppUserCanceledSubscriptionStatus("canceled"), true);
  assert.equal(isAppUserCanceledSubscriptionStatus("cancelled"), true);
  assert.equal(isAppUserCanceledSubscriptionStatus("active"), false);
});

test("isAppUserStarterSubscription matches owner starter, app starter key, and OM plan id", () => {
  assert.equal(
    isAppUserStarterSubscription(
      sub({ id: "1", planKey: "pymthouse_owner_starter" }),
      "app_starter",
      null,
    ),
    true,
  );
  assert.equal(
    isAppUserStarterSubscription(
      sub({ id: "2", planKey: "app_starter" }),
      "app_starter",
      null,
    ),
    true,
  );
  assert.equal(
    isAppUserStarterSubscription(
      sub({ id: "3", planKey: "other", planId: "om_starter" }),
      "app_starter",
      "om_starter",
    ),
    true,
  );
  assert.equal(
    isAppUserStarterSubscription(
      sub({ id: "4", planKey: "paid", planId: "om_paid" }),
      "app_starter",
      "om_starter",
    ),
    false,
  );
});

test("pickAppUserCancelTargets separates live paid, canceled paid, and starter", () => {
  const listed = [
    sub({ id: "paid", planKey: "paid", status: "active" }),
    sub({
      id: "canceled",
      planKey: "old_paid",
      status: "canceled",
      activeTo: "2026-09-01T00:00:00.000Z",
    }),
    sub({ id: "starter", planKey: "app_starter", status: "active" }),
  ];
  const picked = pickAppUserCancelTargets(listed, "app_starter", null);
  assert.equal(picked.livePaid?.id, "paid");
  assert.equal(picked.canceledPaid?.id, "canceled");
  assert.equal(picked.liveStarter?.id, "starter");
});

test("resolveAppUserResumeTarget prefers canceled paid, else live paid + scheduled starter", () => {
  assert.equal(
    resolveAppUserResumeTarget(
      [sub({ id: "paid", planKey: "paid", status: "active" })],
      "app_starter",
      null,
    ),
    null,
  );

  const canceled = resolveAppUserResumeTarget(
    [
      sub({
        id: "paid_canceled",
        planKey: "paid",
        status: "canceled",
        activeTo: "2026-09-01T00:00:00.000Z",
      }),
    ],
    "app_starter",
    null,
  );
  assert.equal(canceled?.target.id, "paid_canceled");

  const withScheduled = resolveAppUserResumeTarget(
    [
      sub({ id: "paid", planKey: "paid", status: "active" }),
      sub({ id: "starter", planKey: "app_starter", status: "scheduled" }),
    ],
    "app_starter",
    null,
  );
  assert.equal(withScheduled?.target.id, "paid");
  assert.equal(withScheduled?.scheduledStarter?.id, "starter");
});

test("deriveAppUserPendingCancel returns canceled paid row", () => {
  assert.equal(
    deriveAppUserPendingCancel({
      listed: [sub({ id: "paid", planKey: "paid", status: "active" })],
      starterPlanKey: "app_starter",
      starterOpenMeterPlanId: null,
      planId: null,
      planName: null,
    }),
    null,
  );

  assert.deepEqual(
    deriveAppUserPendingCancel({
      listed: [
        sub({
          id: "paid_canceled",
          planKey: "paid",
          status: "canceled",
          activeTo: "2026-09-01T00:00:00.000Z",
        }),
      ],
      starterPlanKey: "app_starter",
      starterOpenMeterPlanId: null,
      planId: "local_plan",
      planName: "Pro",
    }),
    {
      subscriptionId: "paid_canceled",
      planId: "local_plan",
      planKey: "paid",
      planName: "Pro",
      effectiveAt: "2026-09-01T00:00:00.000Z",
    },
  );
});
