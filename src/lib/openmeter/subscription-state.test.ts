import assert from "node:assert/strict";
import test from "node:test";

import type { OpenMeterSubscriptionView } from "@/lib/openmeter/subscription-read";
import {
  classifySubscriptions,
  clearScheduledBeforeMutation,
  clearScheduledSubscriptions,
  isCanceledSubscriptionStatus,
  isKonnectScheduledChangeForbidden,
  isLiveSubscriptionStatus,
  isPresentSubscriptionStatus,
  isScheduledSubscriptionStatus,
  listScheduledSubscriptionIds,
  pickLiveSubscription,
  pickMutationTargetSubscription,
  pickOccupyingCanceledSubscription,
  reactivateOccupyingCanceledSubscription,
  resolveResumeTarget,
} from "@/lib/openmeter/subscription-state";

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

function sub(
  partial: Partial<OpenMeterSubscriptionView> & { id: string },
): OpenMeterSubscriptionView {
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

const isStarter = (s: OpenMeterSubscriptionView) =>
  s.planKey === "app_starter" || s.planKey === "pymthouse_owner_starter";

test("status predicates: live excludes scheduled", () => {
  assert.equal(isLiveSubscriptionStatus("active"), true);
  assert.equal(isLiveSubscriptionStatus("trialing"), true);
  assert.equal(isLiveSubscriptionStatus(""), false);
  assert.equal(isLiveSubscriptionStatus(undefined), false);
  assert.equal(isLiveSubscriptionStatus("scheduled"), false);
  assert.equal(isLiveSubscriptionStatus("pending"), false);
  assert.equal(isLiveSubscriptionStatus("canceled"), false);

  assert.equal(isScheduledSubscriptionStatus("scheduled"), true);
  assert.equal(isScheduledSubscriptionStatus("pending"), true);
  assert.equal(isScheduledSubscriptionStatus("active"), false);

  assert.equal(isCanceledSubscriptionStatus("canceled"), true);
  assert.equal(isCanceledSubscriptionStatus("cancelled"), true);
  assert.equal(isCanceledSubscriptionStatus("inactive"), true);
  assert.equal(isCanceledSubscriptionStatus("active"), false);

  assert.equal(isPresentSubscriptionStatus("scheduled"), true);
  assert.equal(isPresentSubscriptionStatus("active"), true);
  assert.equal(isPresentSubscriptionStatus("canceled"), false);
});

test("isOccupyingCanceledSubscription requires future activeTo", async () => {
  const {
    isOccupyingCanceledSubscription,
    pickOccupyingCanceledSubscription,
  } = await import("./subscription-state");
  const now = Date.parse("2026-08-07T21:00:00.000Z");
  assert.equal(
    isOccupyingCanceledSubscription(
      {
        status: "canceled",
        activeTo: "2026-09-07T17:35:18.109Z",
      },
      now,
    ),
    true,
  );
  assert.equal(
    isOccupyingCanceledSubscription(
      { status: "inactive", activeTo: "2026-09-07T17:35:18.109Z" },
      now,
    ),
    true,
  );
  assert.equal(
    isOccupyingCanceledSubscription(
      { status: "canceled", activeTo: "2026-08-01T00:00:00.000Z" },
      now,
    ),
    false,
  );
  assert.equal(
    isOccupyingCanceledSubscription(
      { status: "active", activeTo: "2026-09-07T17:35:18.109Z" },
      now,
    ),
    false,
  );

  const picked = pickOccupyingCanceledSubscription([
    sub({
      id: "starter_canceled",
      planKey: "app_starter",
      status: "canceled",
      activeTo: "2026-09-07T17:35:18.109Z",
    }),
  ]);
  assert.equal(picked?.id, "starter_canceled");
});

test("isOccupyingCanceledSubscription reads Konnect rows that omit activeTo", async () => {
  const { isOccupyingCanceledSubscription, pickOccupyingCanceledSubscription } =
    await import("./subscription-state");
  const now = Date.parse("2026-08-07T21:00:00.000Z");

  // Konnect Metering & Billing v3 `GET /subscriptions` never returns activeTo:
  // `canceled` is cancel-at-period-end and still holds the customer slot.
  assert.equal(
    isOccupyingCanceledSubscription({ status: "canceled", activeTo: null }, now),
    true,
  );
  // `inactive` is a row whose period already ended (superseded by a /change).
  assert.equal(
    isOccupyingCanceledSubscription({ status: "inactive", activeTo: null }, now),
    false,
  );
  assert.equal(
    isOccupyingCanceledSubscription({ status: "active", activeTo: null }, now),
    false,
  );

  const picked = pickOccupyingCanceledSubscription([
    sub({
      id: "01KZF91J0HE97V0M44NTFC2ADZ",
      planKey: "a6c95d934_plan_bc43f59d",
      status: "inactive",
    }),
    sub({
      id: "01KZCN0AH450JWA381D2AN7NJK",
      planKey: "a6c95d934_plan_397fcf2f",
      status: "canceled",
    }),
  ]);
  assert.equal(picked?.id, "01KZCN0AH450JWA381D2AN7NJK");
});

test("classifySubscriptions never treats scheduled as livePaid", () => {
  const listed = [
    sub({ id: "live", planKey: "paid", status: "active" }),
    sub({ id: "sched", planKey: "app_starter", status: "scheduled" }),
    sub({
      id: "canceled",
      planKey: "old_paid",
      status: "canceled",
      activeTo: "2026-09-01T00:00:00.000Z",
    }),
  ];
  const c = classifySubscriptions(listed, isStarter);
  assert.equal(c.livePaid?.id, "live");
  assert.equal(c.scheduledStarter?.id, "sched");
  assert.equal(c.canceledPaid?.id, "canceled");
  assert.deepEqual(c.scheduledIds, ["sched"]);
});

test("classifySubscriptions surfaces scheduledPaid when no live paid", () => {
  const c = classifySubscriptions(
    [sub({ id: "sched_paid", planKey: "paid", status: "scheduled" })],
    isStarter,
  );
  assert.equal(c.livePaid, undefined);
  assert.equal(c.scheduledPaid?.id, "sched_paid");
  assert.deepEqual(c.scheduledIds, ["sched_paid"]);
});

test("pickMutationTargetSubscription prefers live paid over scheduled successor", () => {
  const listed = [
    sub({
      id: "sched_paid",
      planKey: "paid_v2",
      status: "scheduled",
      activeFrom: "2026-09-01T00:00:00.000Z",
    }),
    sub({
      id: "live_paid",
      planKey: "paid_v1",
      status: "active",
      activeFrom: "2026-08-01T00:00:00.000Z",
    }),
  ];
  assert.equal(pickMutationTargetSubscription(listed, isStarter)?.id, "live_paid");
  assert.equal(pickLiveSubscription(listed)?.id, "live_paid");
  assert.deepEqual(listScheduledSubscriptionIds(listed), ["sched_paid"]);
});

test("pickMutationTargetSubscription returns null when only scheduled exists", () => {
  const listed = [
    sub({ id: "sched", planKey: "paid", status: "scheduled" }),
  ];
  assert.equal(pickMutationTargetSubscription(listed, isStarter), null);
  assert.equal(pickLiveSubscription(listed), null);
});

test("resolveResumeTarget prefers canceled paid, else live + scheduled starter", () => {
  assert.equal(
    resolveResumeTarget(
      [sub({ id: "paid", planKey: "paid", status: "active" })],
      isStarter,
    ),
    null,
  );

  const canceled = resolveResumeTarget(
    [
      sub({
        id: "paid_canceled",
        planKey: "paid",
        status: "canceled",
        activeTo: "2026-09-01T00:00:00.000Z",
      }),
    ],
    isStarter,
  );
  assert.equal(canceled?.target.id, "paid_canceled");

  const withScheduled = resolveResumeTarget(
    [
      sub({ id: "paid", planKey: "paid", status: "active" }),
      sub({ id: "starter", planKey: "app_starter", status: "scheduled" }),
    ],
    isStarter,
  );
  assert.equal(withScheduled?.target.id, "paid");
  assert.equal(withScheduled?.scheduledStarter?.id, "starter");
});

test("resolveResumeTarget ignores canceled rows that no longer occupy", () => {
  // Superseded by a /change: `inactive`, period already over. Resume must report
  // nothing_to_resume rather than restore a plan the user left.
  assert.equal(
    resolveResumeTarget(
      [
        sub({
          id: "01KZF91J0HE97V0M44NTFC2ADZ",
          planKey: "paid",
          status: "inactive",
        }),
        sub({ id: "01KZFG1WS3AEZX6E59H7VBWNQN", planKey: "paid", status: "active" }),
      ],
      isStarter,
    ),
    null,
  );

  assert.equal(
    resolveResumeTarget(
      [
        sub({
          id: "expired",
          planKey: "paid",
          status: "canceled",
          activeTo: "2020-01-01T00:00:00.000Z",
        }),
      ],
      isStarter,
    ),
    null,
  );

  // Konnect cancel-at-period-end: `canceled` with no activeTo is still live, so
  // it stays resumable and a failing Konnect restore can still raise resume_failed.
  assert.equal(
    resolveResumeTarget(
      [sub({ id: "01KZCN0AH450JWA381D2AN7NJK", planKey: "paid", status: "canceled" })],
      isStarter,
    )?.target.id,
    "01KZCN0AH450JWA381D2AN7NJK",
  );
});

test("isKonnectScheduledChangeForbidden matches Konnect 403 detail", () => {
  assert.equal(
    isKonnectScheduledChangeForbidden(
      new Error(
        'Konnect subscription-change API failed (403): {"detail":"forbidden error: transition cancel in state scheduled not allowed"}',
      ),
    ),
    true,
  );
  assert.equal(
    isKonnectScheduledChangeForbidden(new Error("unrelated")),
    false,
  );
});

test("clearScheduledSubscriptions DELETEs each scheduled id", async (t) => {
  withKonnectEnv(t);
  const urls: string[] = [];
  t.mock.method(globalThis, "fetch", async (input: RequestInfo | URL) => {
    urls.push(String(input));
    return new Response(null, { status: 204 });
  });

  await clearScheduledSubscriptions(["sched_a", "sched_b"]);
  assert.equal(urls.length, 2);
  assert.match(urls[0]!, /\/metering\/v1\/subscriptions\/sched_a$/);
  assert.match(urls[1]!, /\/metering\/v1\/subscriptions\/sched_b$/);
});

test("clearScheduledSubscriptions falls back to cancel when DELETE fails", async (t) => {
  withKonnectEnv(t);
  const urls: string[] = [];
  t.mock.method(globalThis, "fetch", async (input: RequestInfo | URL) => {
    const url = String(input);
    urls.push(url);
    if (url.includes("/cancel")) {
      return new Response(
        JSON.stringify({ id: "sched_a", status: "canceled", customer_id: "c1" }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }
    return new Response(JSON.stringify({ detail: "not deletable" }), {
      status: 405,
      headers: { "Content-Type": "application/json" },
    });
  });

  await clearScheduledSubscriptions(["sched_a"]);
  assert.equal(urls.length, 2);
  assert.match(urls[0]!, /\/metering\/v1\/subscriptions\/sched_a$/);
  assert.match(urls[1]!, /\/subscriptions\/sched_a\/cancel$/);
});

test("clearScheduledBeforeMutation restores canceled Paid when provided", async (t) => {
  withKonnectEnv(t);
  const urls: string[] = [];
  t.mock.method(globalThis, "fetch", async (input: RequestInfo | URL) => {
    urls.push(String(input));
    return new Response(
      JSON.stringify({ id: "paid_canceled", status: "active", customer_id: "c1" }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  });

  await clearScheduledBeforeMutation({
    scheduledIds: ["sched_successor"],
    canceledPaidId: "paid_canceled",
  });
  assert.equal(urls.length, 1);
  assert.match(urls[0]!, /\/metering\/v1\/subscriptions\/paid_canceled\/restore$/);
});

test("clearScheduledBeforeMutation clears scheduled when restore fails", async (t) => {
  withKonnectEnv(t);
  const urls: string[] = [];
  t.mock.method(globalThis, "fetch", async (input: RequestInfo | URL) => {
    const url = String(input);
    urls.push(url);
    if (url.includes("/restore")) {
      return new Response(JSON.stringify({ detail: "conflict" }), {
        status: 409,
        headers: { "Content-Type": "application/json" },
      });
    }
    return new Response(null, { status: 204 });
  });

  await clearScheduledBeforeMutation({
    scheduledIds: ["sched_successor"],
    canceledPaidId: "paid_canceled",
  });
  assert.equal(urls.length, 2);
  assert.match(urls[0]!, /\/restore$/);
  assert.match(urls[1]!, /\/metering\/v1\/subscriptions\/sched_successor$/);
});

test("clearScheduledSubscriptions swallows cancel failure after DELETE fails", async (t) => {
  withKonnectEnv(t);
  t.mock.method(globalThis, "fetch", async () =>
    new Response(JSON.stringify({ detail: "still forbidden" }), {
      status: 403,
      headers: { "Content-Type": "application/json" },
    }),
  );

  await assert.doesNotReject(() => clearScheduledSubscriptions(["sched_a"]));
});

test("pickMutationTargetSubscription falls back to live starter", () => {
  const listed = [
    sub({ id: "starter", planKey: "app_starter", status: "active" }),
  ];
  assert.equal(pickMutationTargetSubscription(listed, isStarter)?.id, "starter");
});

test("pickOccupyingCanceledSubscription selects future activeTo rows", () => {
  const listed = [
    sub({
      id: "old",
      planKey: "app_starter",
      status: "canceled",
      activeTo: "2020-01-01T00:00:00.000Z",
    }),
    sub({
      id: "still_open",
      planKey: "app_starter",
      status: "inactive",
      activeTo: "2099-01-01T00:00:00.000Z",
    }),
  ];
  assert.equal(pickOccupyingCanceledSubscription(listed)?.id, "still_open");
});

test("reactivateOccupyingCanceledSubscription unschedules cancelation", async (t) => {
  withKonnectEnv(t);
  const urls: string[] = [];
  t.mock.method(globalThis, "fetch", async (input: RequestInfo | URL) => {
    urls.push(String(input));
    return new Response(
      JSON.stringify({ id: "sub_1", status: "active", customer_id: "c1" }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  });

  await reactivateOccupyingCanceledSubscription("sub_1");
  assert.equal(urls.length, 1);
  assert.match(urls[0]!, /\/unschedule-cancelation$/);
});

test("reactivateOccupyingCanceledSubscription falls back to restore", async (t) => {
  withKonnectEnv(t);
  const urls: string[] = [];
  t.mock.method(globalThis, "fetch", async (input: RequestInfo | URL) => {
    const url = String(input);
    urls.push(url);
    if (url.includes("/unschedule-cancelation")) {
      return new Response(JSON.stringify({ detail: "conflict" }), {
        status: 409,
        headers: { "Content-Type": "application/json" },
      });
    }
    return new Response(
      JSON.stringify({ id: "sub_1", status: "active", customer_id: "c1" }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  });

  await reactivateOccupyingCanceledSubscription("sub_1");
  assert.equal(urls.length, 2);
  assert.match(urls[0]!, /\/unschedule-cancelation$/);
  assert.match(urls[1]!, /\/metering\/v1\/subscriptions\/sub_1\/restore$/);
});

test("reactivateOccupyingCanceledSubscription no-ops on blank id", async () => {
  await assert.doesNotReject(() => reactivateOccupyingCanceledSubscription("  "));
});

test("status predicates cover null/undefined and cancelled spelling", () => {
  assert.equal(isScheduledSubscriptionStatus(null), false);
  assert.equal(isScheduledSubscriptionStatus(undefined), false);
  assert.equal(isCanceledSubscriptionStatus(null), false);
  assert.equal(isCanceledSubscriptionStatus("CANCELLED"), true);
  assert.equal(isCanceledSubscriptionStatus("INACTIVE"), true);
  assert.equal(isKonnectScheduledChangeForbidden("cancel in state scheduled"), true);
});

test("clearScheduledBeforeMutation clears when canceledPaidId omitted", async (t) => {
  withKonnectEnv(t);
  const urls: string[] = [];
  t.mock.method(globalThis, "fetch", async (input: RequestInfo | URL) => {
    urls.push(String(input));
    return new Response(null, { status: 204 });
  });

  await clearScheduledBeforeMutation({ scheduledIds: ["sched_only"] });
  assert.equal(urls.length, 1);
  assert.match(urls[0]!, /\/metering\/v1\/subscriptions\/sched_only$/);
});

test("pickOccupyingCanceledSubscription skips rows without id", () => {
  assert.equal(
    pickOccupyingCanceledSubscription([
      sub({
        id: "",
        planKey: "paid",
        status: "canceled",
        activeTo: "2099-01-01T00:00:00.000Z",
      }),
    ]),
    undefined,
  );
});
