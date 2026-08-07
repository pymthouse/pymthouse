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
  assert.equal(isCanceledSubscriptionStatus("active"), false);

  assert.equal(isPresentSubscriptionStatus("scheduled"), true);
  assert.equal(isPresentSubscriptionStatus("active"), true);
  assert.equal(isPresentSubscriptionStatus("canceled"), false);
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
