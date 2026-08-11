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
  resumeAppUserSubscriptionFromList,
  scheduleLivePaidCancel,
  immediateCancelOccupyingCapePaid,
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
  // scheduled/pending/empty are NOT live — Konnect forbids cancel/change on them
  assert.equal(isAppUserLiveSubscriptionStatus("scheduled"), false);
  assert.equal(isAppUserLiveSubscriptionStatus("pending"), false);
  assert.equal(isAppUserLiveSubscriptionStatus(""), false);
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
    sub({ id: "sched", planKey: "app_starter", status: "scheduled" }),
  ];
  const picked = pickAppUserCancelTargets(listed, "app_starter", null);
  assert.equal(picked.livePaid?.id, "paid");
  assert.equal(picked.canceledPaid?.id, "canceled");
  assert.equal(picked.liveStarter?.id, "starter");
  assert.equal(picked.scheduledStarter?.id, "sched");
  assert.deepEqual(picked.scheduledIds, ["sched"]);
});

test("pickAppUserCancelTargets does not treat scheduled paid as livePaid", () => {
  const listed = [
    sub({
      id: "sched_paid",
      planKey: "paid",
      status: "scheduled",
      activeFrom: "2026-09-01T00:00:00.000Z",
    }),
  ];
  const picked = pickAppUserCancelTargets(listed, "app_starter", null);
  assert.equal(picked.livePaid, undefined);
  assert.equal(picked.scheduledPaid?.id, "sched_paid");
  assert.deepEqual(picked.scheduledIds, ["sched_paid"]);
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
      subscription: sub({ id: "paid", planKey: "paid", status: "active" }),
      planId: null,
      planName: null,
    }),
    null,
  );

  assert.deepEqual(
    deriveAppUserPendingCancel({
      subscription: sub({
        id: "paid_canceled",
        planKey: "paid",
        status: "canceled",
        activeTo: "2026-09-01T00:00:00.000Z",
      }),
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

test("deriveAppUserPendingCancel surfaces cancel-at-period-end Starter", () => {
  assert.deepEqual(
    deriveAppUserPendingCancel({
      subscription: sub({
        id: "starter_canceled",
        planKey: "app_starter",
        status: "canceled",
        activeTo: "2026-09-07T17:35:18.109Z",
      }),
      planId: "starter_local",
      planName: "Starter",
    }),
    {
      subscriptionId: "starter_canceled",
      planId: "starter_local",
      planKey: "app_starter",
      planName: "Starter",
      effectiveAt: "2026-09-07T17:35:18.109Z",
    },
  );
});

test("deriveAppUserPendingCancel dates the banner from the enriched window", () => {
  // Konnect v3 sends no activeTo, so the row is enriched from /metering/v1
  // before it reaches here. Without that the callout rendered "stays active
  // until" with no date.
  assert.deepEqual(
    deriveAppUserPendingCancel({
      subscription: sub({
        id: "01KZCN0AH450JWA381D2AN7NJK",
        planKey: "a6c95d934_plan_397fcf2f",
        status: "canceled",
        activeFrom: "2026-08-06T23:02:17.378589Z",
        activeTo: "2026-09-06T23:02:17.378589Z",
      }),
      planId: "397fcf2f",
      planName: "Pay as you go",
    }),
    {
      subscriptionId: "01KZCN0AH450JWA381D2AN7NJK",
      planId: "397fcf2f",
      planKey: "a6c95d934_plan_397fcf2f",
      planName: "Pay as you go",
      effectiveAt: "2026-09-06T23:02:17.378589Z",
    },
  );
});

test("resolveAppUserResumeTarget agrees with the reported pendingCancel", () => {
  const superseded = sub({
    id: "01KZF91J0HE97V0M44NTFC2ADZ",
    planKey: "paid",
    status: "inactive",
  });
  // GET reports no pendingCancel for this row, so resume must find no target
  // and answer nothing_to_resume (404) rather than resume_failed (502).
  assert.equal(
    deriveAppUserPendingCancel({
      subscription: superseded,
      planId: null,
      planName: null,
    }),
    null,
  );
  assert.equal(
    resolveAppUserResumeTarget([superseded], "app_starter", null),
    null,
  );
  assert.equal(appUserSubscriptionResumeHttpStatus("nothing_to_resume"), 404);
  assert.equal(appUserSubscriptionResumeHttpStatus("resume_failed"), 502);
});

test("resolveAppUserResumeTarget resumes CAPE primary when a scheduled successor exists", () => {
  // GET prefers occupying cancel-at-period-end over the scheduled successor, so
  // pendingCancel belongs to the paid CAPE row and resume must target it (and
  // clear the scheduled starter). A superseded inactive starter is ignored.
  const listed = [
    sub({
      id: "paid_canceled",
      planKey: "paid",
      status: "canceled",
      activeFrom: "2026-08-08T03:00:31.842771Z",
      activeTo: "2026-09-08T03:00:31.842771Z",
    }),
    sub({
      id: "starter_scheduled",
      planKey: "app_starter",
      status: "scheduled",
      activeFrom: "2026-09-08T03:00:31.842771Z",
    }),
    sub({ id: "superseded", planKey: "app_starter", status: "inactive" }),
  ];

  const resume = resolveAppUserResumeTarget(listed, "app_starter", null);
  assert.equal(resume?.target.id, "paid_canceled");
  assert.equal(resume?.scheduledStarter?.id, "starter_scheduled");
  // livePaid is absent for CAPE — resume must still restore (not unschedule)
  // so Konnect does not 409 only_single_subscription_allowed.
  assert.equal(resume?.livePaid, undefined);
});

test("resolveAppUserResumeTarget resumes CAPE when scheduled successor is paid", () => {
  // Staging 409: CAPE Daydream + scheduled paid successor from a prior /change.
  // Resume must restore (any scheduled id), not only scheduled Starter.
  const listed = [
    sub({
      id: "01KZQ3YQYZSDKANZC0SAW0VV20",
      planKey: "paid_a",
      status: "canceled",
      activeFrom: "2026-08-11T00:35:58.500843Z",
      activeTo: "2026-09-10T23:08:53.491143Z",
    }),
    sub({
      id: "sched_paid_b",
      planKey: "paid_b",
      status: "scheduled",
      activeFrom: "2026-09-10T23:08:53.491143Z",
    }),
  ];
  const resume = resolveAppUserResumeTarget(listed, "app_starter", null);
  assert.equal(resume?.target.id, "01KZQ3YQYZSDKANZC0SAW0VV20");
  assert.equal(resume?.scheduledStarter, undefined);
});

test("resolveAppUserResumeTarget keeps a cancel-at-period-end primary resumable", () => {
  // No live or scheduled row exists, so the canceled row IS what GET reports.
  // Scoping must not turn this into a 404 — it is the whole point of resume.
  const canceled = sub({
    id: "paid_canceled",
    planKey: "paid",
    status: "canceled",
    activeFrom: "2026-08-08T03:00:31.842771Z",
    activeTo: "2026-09-08T03:00:31.842771Z",
  });
  const listed = [
    canceled,
    sub({ id: "superseded", planKey: "app_starter", status: "inactive" }),
  ];

  const resume = resolveAppUserResumeTarget(listed, "app_starter", null);
  assert.equal(resume?.target.id, "paid_canceled");
  // A target resolves, so the restore call and its catch still run — that catch
  // is what maps a Konnect failure to resume_failed / 502.
  assert.equal(appUserSubscriptionResumeHttpStatus("resume_failed"), 502);
});

test("resolveAppUserResumeTarget resumes occupying CAPE after paid→paid change", () => {
  // Predecessor ends (`inactive`); successor is cancel-at-period-end. GET reports
  // pendingCancel on B; resume must not 404 nothing_to_resume because A is first.
  const occupying = sub({
    id: "paid_b_cape",
    planKey: "paid_b",
    status: "canceled",
    activeFrom: "2026-08-08T03:00:31.842771Z",
    activeTo: "2026-09-08T03:00:31.842771Z",
  });
  const listed = [
    sub({ id: "paid_a_ended", planKey: "paid_a", status: "inactive" }),
    occupying,
  ];

  assert.equal(
    deriveAppUserPendingCancel({
      subscription: occupying,
      planId: "b",
      planName: "Plan B",
    })?.subscriptionId,
    "paid_b_cape",
  );
  assert.equal(
    resolveAppUserResumeTarget(listed, "app_starter", null)?.target.id,
    "paid_b_cape",
  );
});

test("deriveAppUserPendingCancel ignores a superseded row's cancellation", () => {
  // Konnect leaves the pre-/change row behind as `inactive` with a
  // `superseding.id` label. Reporting it as pendingCancel next to the live
  // successor offers a "keep plan" action that resume answers nothing_to_resume.
  assert.equal(
    deriveAppUserPendingCancel({
      subscription: sub({
        id: "01KZFG1WS3AEZX6E59H7VBWNQN",
        planKey: "a6c95d934_plan_397fcf2f",
        status: "active",
      }),
      planId: "397fcf2f",
      planName: "Pay as you go",
    }),
    null,
  );
  assert.equal(
    deriveAppUserPendingCancel({
      subscription: sub({
        id: "01KZF91J0HE97V0M44NTFC2ADZ",
        planKey: "a6c95d934_plan_bc43f59d",
        status: "inactive",
      }),
      planId: "bc43f59d",
      planName: "m2m user plan",
    }),
    null,
  );
});

function withKonnectEnv(t: test.TestContext): void {
  const savedUrl = process.env.OPENMETER_URL;
  const savedKey = process.env.OPENMETER_API_KEY;
  const savedMode = process.env.OPENMETER_ROUTE_MODE;
  process.env.OPENMETER_URL = "https://us.api.konghq.com/v3/openmeter";
  process.env.OPENMETER_API_KEY = "km_test_key";
  process.env.OPENMETER_ROUTE_MODE = "hosted";
  t.after(() => {
    if (savedUrl === undefined) delete process.env.OPENMETER_URL;
    else process.env.OPENMETER_URL = savedUrl;
    if (savedKey === undefined) delete process.env.OPENMETER_API_KEY;
    else process.env.OPENMETER_API_KEY = savedKey;
    if (savedMode === undefined) delete process.env.OPENMETER_ROUTE_MODE;
    else process.env.OPENMETER_ROUTE_MODE = savedMode;
  });
}

test("scheduleLivePaidCancel immediate changes onto Starter with null scheduledPlanKey", async (t) => {
  withKonnectEnv(t);
  const urls: string[] = [];
  t.mock.method(globalThis, "fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    urls.push(`${init?.method ?? "GET"} ${String(input)}`);
    return new Response(
      JSON.stringify({
        current: { id: "paid_1", status: "canceled", customer_id: "c1" },
        next: { id: "starter_live", status: "active", customer_id: "c1" },
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  });

  const result = await scheduleLivePaidCancel({
    livePaid: sub({ id: "paid_1", planKey: "paid", status: "active" }),
    localPlanId: "local_paid",
    starterPlanKey: "app_starter",
    starterLocalPlanId: "local_starter",
    starterOpenMeterPlanId: "om_starter",
    timing: "immediate",
    customerId: "c1",
  });

  assert.equal(result.subscriptionId, "starter_live");
  assert.equal(result.planId, "local_starter");
  assert.equal(result.planKey, "app_starter");
  assert.equal(result.scheduledPlanKey, null);
  assert.ok(result.effectiveAt);
  assert.equal(urls.length, 1);
  assert.match(urls[0]!, /\/change/);
});

test("scheduleLivePaidCancel immediate fails when Starter is not synced", async () => {
  await assert.rejects(
    () =>
      scheduleLivePaidCancel({
        livePaid: sub({ id: "paid_1", planKey: "paid", status: "active" }),
        localPlanId: "local_paid",
        starterPlanKey: "app_starter",
        starterLocalPlanId: "local_starter",
        starterOpenMeterPlanId: null,
        timing: "immediate",
        customerId: "c1",
      }),
    (err: unknown) =>
      err instanceof AppUserSubscriptionCancelError &&
      err.code === "cancel_failed",
  );
});

test("scheduleLivePaidCancel next_billing_cycle cancels and schedules Starter", async (t) => {
  withKonnectEnv(t);
  t.mock.method(globalThis, "fetch", async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("/cancel")) {
      return new Response(
        JSON.stringify({
          id: "paid_1",
          status: "canceled",
          customer_id: "c1",
          billing_anchor: "2026-08-01T00:00:00.000Z",
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }
    // active window lookup
    return new Response(
      JSON.stringify({
        id: "paid_1",
        status: "canceled",
        customer_id: "c1",
        active_to: "2026-09-01T00:00:00.000Z",
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  });

  const result = await scheduleLivePaidCancel({
    livePaid: sub({
      id: "paid_1",
      planKey: "paid",
      status: "active",
      activeTo: null,
    }),
    localPlanId: "local_paid",
    starterPlanKey: "app_starter",
    starterLocalPlanId: "local_starter",
    starterOpenMeterPlanId: "om_starter",
    timing: "next_billing_cycle",
    customerId: "c1",
  });

  assert.equal(result.subscriptionId, "paid_1");
  assert.equal(result.planId, "local_paid");
  assert.equal(result.scheduledPlanKey, "app_starter");
  assert.equal(result.effectiveAt, "2026-09-01T00:00:00.000Z");
});

test("resumeAppUserSubscriptionFromList restores when a scheduled successor exists", async (t) => {
  withKonnectEnv(t);
  const urls: string[] = [];
  t.mock.method(globalThis, "fetch", async (input: RequestInfo | URL) => {
    urls.push(String(input));
    return new Response(
      JSON.stringify({ id: "paid_cape", status: "active", customer_id: "c1" }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  });

  const listed = [
    sub({
      id: "paid_cape",
      planKey: "paid",
      status: "canceled",
      activeTo: "2026-09-01T00:00:00.000Z",
    }),
    sub({
      id: "sched_starter",
      planKey: "app_starter",
      status: "scheduled",
      activeFrom: "2026-09-01T00:00:00.000Z",
    }),
  ];

  const result = await resumeAppUserSubscriptionFromList({
    clientId: "app_missing_plans_ok",
    listed,
    starterPlanKey: "app_starter",
    starterOpenMeterPlanId: null,
  });

  assert.equal(result.resumed, true);
  assert.equal(result.subscriptionId, "paid_cape");
  assert.equal(result.planKey, "paid");
  assert.equal(urls.length, 1);
  assert.match(urls[0]!, /\/restore$/);
});

test("resumeAppUserSubscriptionFromList unschedules when no successor exists", async (t) => {
  withKonnectEnv(t);
  const urls: string[] = [];
  t.mock.method(globalThis, "fetch", async (input: RequestInfo | URL) => {
    urls.push(String(input));
    return new Response(
      JSON.stringify({ id: "paid_cape", status: "active", customer_id: "c1" }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  });

  const listed = [
    sub({
      id: "paid_cape",
      planKey: "paid",
      status: "canceled",
      activeTo: "2026-09-01T00:00:00.000Z",
    }),
  ];

  const result = await resumeAppUserSubscriptionFromList({
    clientId: "app_missing_plans_ok",
    listed,
    starterPlanKey: "app_starter",
    starterOpenMeterPlanId: null,
  });

  assert.equal(result.resumed, true);
  assert.equal(result.subscriptionId, "paid_cape");
  assert.equal(urls.length, 1);
  assert.match(urls[0]!, /unschedule-cancelation/);
});

test("resumeAppUserSubscriptionFromList falls back to restore on unschedule 409", async (t) => {
  withKonnectEnv(t);
  const urls: string[] = [];
  t.mock.method(globalThis, "fetch", async (input: RequestInfo | URL) => {
    const url = String(input);
    urls.push(url);
    if (url.includes("unschedule-cancelation")) {
      return new Response(
        JSON.stringify({
          detail: "only_single_subscription_allowed_per_customer_at_a_time",
        }),
        { status: 409, headers: { "Content-Type": "application/json" } },
      );
    }
    return new Response(
      JSON.stringify({ id: "paid_cape", status: "active", customer_id: "c1" }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  });

  const listed = [
    sub({
      id: "paid_cape",
      planKey: "paid",
      status: "canceled",
      activeTo: "2026-09-01T00:00:00.000Z",
    }),
  ];

  const result = await resumeAppUserSubscriptionFromList({
    clientId: "app_missing_plans_ok",
    listed,
    starterPlanKey: "app_starter",
    starterOpenMeterPlanId: null,
  });

  assert.equal(result.resumed, true);
  assert.equal(urls.length, 2);
  assert.match(urls[0]!, /unschedule-cancelation/);
  assert.match(urls[1]!, /\/restore$/);
});

test("immediateCancelOccupyingCapePaid restores then changes onto Starter", async (t) => {
  withKonnectEnv(t);
  const urls: string[] = [];
  t.mock.method(globalThis, "fetch", async (input: RequestInfo | URL) => {
    const url = String(input);
    urls.push(url);
    if (url.includes("/restore")) {
      return new Response(
        JSON.stringify({ id: "paid_cape", status: "active", customer_id: "c1" }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }
    if (url.includes("/change")) {
      return new Response(
        JSON.stringify({
          current: { id: "paid_cape", status: "canceled", customer_id: "c1" },
          next: { id: "starter_now", status: "active", customer_id: "c1" },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }
    return new Response("unexpected", { status: 500 });
  });

  const result = await immediateCancelOccupyingCapePaid({
    canceledPaid: sub({
      id: "paid_cape",
      planKey: "paid",
      status: "canceled",
      activeTo: "2026-09-01T00:00:00.000Z",
    }),
    scheduledIds: ["sched_starter"],
    clientId: "app_missing_plans_ok",
    starterPlanKey: "app_starter",
    starterLocalPlanId: "local_starter",
    starterOpenMeterPlanId: "om_starter",
    customerId: "c1",
  });

  assert.equal(result.subscriptionId, "starter_now");
  assert.equal(result.planId, "local_starter");
  assert.equal(result.scheduledPlanKey, null);
  assert.equal(urls.length, 2);
  assert.match(urls[0]!, /\/restore$/);
  assert.match(urls[1]!, /\/change/);
});
