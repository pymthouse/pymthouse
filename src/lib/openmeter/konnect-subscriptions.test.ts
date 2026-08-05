import test from "node:test";
import assert from "node:assert/strict";
import {
  cancelKonnectSubscription,
  changeKonnectSubscription,
  countActiveKonnectSubscriptionsForPlan,
  estimateNextBillingCycleIso,
  listActiveKonnectSubscriptions,
  parseSubscriptionTiming,
  restoreKonnectSubscription,
  subscriptionMatchesOpenMeterPlanId,
  unscheduleKonnectSubscriptionCancelation,
} from "./konnect-subscriptions";

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

test("parseSubscriptionTiming accepts only known values", () => {
  assert.equal(parseSubscriptionTiming("immediate"), "immediate");
  assert.equal(parseSubscriptionTiming("next_billing_cycle"), "next_billing_cycle");
  assert.throws(() => parseSubscriptionTiming("later"), /timing must be/);
});

test("estimateNextBillingCycleIso clamps end-of-month anchors", () => {
  assert.equal(estimateNextBillingCycleIso(null), null);
  assert.equal(estimateNextBillingCycleIso("not-a-date"), null);
  assert.equal(
    estimateNextBillingCycleIso("2025-01-31T00:00:00.000Z"),
    "2025-02-28T00:00:00.000Z",
  );
  assert.equal(
    estimateNextBillingCycleIso("2024-01-31T12:30:00.000Z"),
    "2024-02-29T12:30:00.000Z",
  );
  assert.equal(
    estimateNextBillingCycleIso("2025-03-31T00:00:00.000Z"),
    "2025-04-30T00:00:00.000Z",
  );
});

test("subscriptionMatchesOpenMeterPlanId reads plan_id or planId", () => {
  assert.equal(
    subscriptionMatchesOpenMeterPlanId({ id: "s1", status: "active", customer_id: "c1", plan_id: "plan_a" }, "plan_a"),
    true,
  );
  assert.equal(
    subscriptionMatchesOpenMeterPlanId({ id: "s1", status: "active", customer_id: "c1", planId: "plan_b" }, "plan_b"),
    true,
  );
  assert.equal(
    subscriptionMatchesOpenMeterPlanId({ id: "s1", status: "active", customer_id: "c1" }, "plan_a"),
    false,
  );
});

test("changeKonnectSubscription cancel and restore call admin API", async (t) => {
  withKonnectEnv(t);
  const calls: Array<{ url: string; body: string }> = [];
  t.mock.method(globalThis, "fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), body: String(init?.body ?? "") });
    return new Response(JSON.stringify({ id: "sub_1", status: "active", customer_id: "cust_1" }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  });

  await changeKonnectSubscription({
    subscriptionId: "sub_1",
    customerId: "cust_1",
    planId: "plan_2",
    timing: "immediate",
  });
  await cancelKonnectSubscription({ subscriptionId: "sub_1" });
  await restoreKonnectSubscription({ subscriptionId: "sub_1" });
  await unscheduleKonnectSubscriptionCancelation({ subscriptionId: "sub_1" });

  assert.match(calls[0]!.url, /\/subscriptions\/sub_1\/change$/);
  assert.match(calls[0]!.body, /"timing":"immediate"/);
  assert.match(calls[1]!.url, /\/subscriptions\/sub_1\/cancel$/);
  assert.match(calls[1]!.body, /next_billing_cycle/);
  assert.match(calls[2]!.url, /\/metering\/v1\/subscriptions\/sub_1\/restore$/);
  assert.match(calls[3]!.url, /\/subscriptions\/sub_1\/unschedule-cancelation$/);
});

test("listActiveKonnectSubscriptions pages and filters statuses", async (t) => {
  withKonnectEnv(t);
  let page = 0;
  t.mock.method(globalThis, "fetch", async () => {
    page += 1;
    if (page === 1) {
      return new Response(
        JSON.stringify({
          data: [
            { id: "s1", status: "active", customer_id: "c1", plan_id: "plan_a" },
            { id: "s2", status: "canceled", customerId: "c2", planId: "plan_b" },
            { id: "s3", status: "scheduled", customerId: "c3", plan_id: "plan_a" },
          ],
          meta: { page: { size: 100, number: 1, total: 3 } },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }
    throw new Error("should not request another page");
  });

  const active = await listActiveKonnectSubscriptions();
  assert.equal(active.length, 2);
  assert.equal(active[0]!.id, "s1");
  assert.equal(active[1]!.id, "s3");
  assert.equal(active[1]!.customer_id, "c3");
});

test("countActiveKonnectSubscriptionsForPlan counts matching plans", async (t) => {
  withKonnectEnv(t);
  t.mock.method(globalThis, "fetch", async () =>
    new Response(
      JSON.stringify({
        data: [
          { id: "s1", status: "active", customer_id: "c1", plan_id: "plan_a" },
          { id: "s2", status: "active", customer_id: "c2", plan_id: "plan_b" },
        ],
        meta: { page: { size: 100, number: 1, total: 2 } },
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    ),
  );

  assert.equal(await countActiveKonnectSubscriptionsForPlan(""), 0);
  assert.equal(await countActiveKonnectSubscriptionsForPlan("plan_a"), 1);
});

test("konnectAdminFetch errors surface status and body", async (t) => {
  withKonnectEnv(t);
  t.mock.method(globalThis, "fetch", async () =>
    new Response("nope", { status: 500 }),
  );
  await assert.rejects(
    () => cancelKonnectSubscription({ subscriptionId: "sub_x", timing: "immediate" }),
    /failed \(500\): nope/,
  );
});
