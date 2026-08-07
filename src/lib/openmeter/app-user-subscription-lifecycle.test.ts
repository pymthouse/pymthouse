import assert from "node:assert/strict";
import test from "node:test";

import {
  AppUserSubscriptionCancelError,
  AppUserSubscriptionResumeError,
  appUserSubscriptionCancelHttpStatus,
  appUserSubscriptionResumeHttpStatus,
  cancelAppUserSubscription,
  resumeAppUserSubscription,
} from "@/lib/openmeter/app-user-subscription-lifecycle";

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
