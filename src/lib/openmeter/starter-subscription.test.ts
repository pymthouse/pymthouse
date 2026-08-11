import assert from "node:assert/strict";
import test from "node:test";

import {
  createStarterSubscriptionWithBillingRecovery,
  findSlotOccupyingSubscription,
} from "@/lib/openmeter/starter-subscription";
import { resetPlanKeyCacheForTests } from "@/lib/openmeter/subscription-read";

const STARTER_PLAN_KEY = "a6c95d934_plan_397fcf2f";

/** Verbatim Konnect reject that failed every /generate-live-payment request. */
const KONNECT_CREATE_CONFLICT =
  "Request failed (https://us.api.konghq.com/v3/openmeter/subscriptions) [409]: undefined";

/**
 * Staging rows for external user 95c33c7d-…: the Starter row was superseded by
 * Pay as you go, so the Starter-plan-key lookup misses while the live PAYG row
 * still blocks subscriptions.create.
 */
const UPGRADED_OFF_STARTER_ROWS = [
  {
    id: "01KZF91J0HE97V0M44NTFC2ADZ",
    status: "inactive",
    customer_id: "01KZF91HX8XSX4WMP1N4VXNWZ4",
    plan: { key: STARTER_PLAN_KEY },
    active_to: "2026-08-07T20:00:00.000Z",
  },
  {
    id: "01KZFG1WS3AEZX6E59H7VBWNQN",
    status: "active",
    customer_id: "01KZF91HX8XSX4WMP1N4VXNWZ4",
    plan: { key: "a6c95d934_plan_payg" },
  },
];

function clientWithRows(
  rows: unknown[],
  spy?: { creates: number },
  planKeyById?: Record<string, string>,
) {
  return {
    customers: {
      listSubscriptions: async () => ({ items: rows }),
    },
    plans: {
      get: async (id: string) => ({ key: planKeyById?.[id] ?? "unknown_plan" }),
    },
    subscriptions: {
      create: async () => {
        if (spy) {
          spy.creates += 1;
        }
        throw new Error(KONNECT_CREATE_CONFLICT);
      },
    },
  };
}

test("a customer upgraded off Starter provisions with zero create attempts", async (t) => {
  resetPlanKeyCacheForTests();
  t.after(() => resetPlanKeyCacheForTests());

  const spy = { creates: 0 };
  const occupying = await findSlotOccupyingSubscription(
    clientWithRows(UPGRADED_OFF_STARTER_ROWS, spy) as never,
    "01KZF91HX8XSX4WMP1N4VXNWZ4",
  );

  assert.equal(occupying?.id, "01KZFG1WS3AEZX6E59H7VBWNQN");
  assert.equal(occupying?.status, "active");
  // The whole point of the pre-create check: Konnect is never asked to create.
  assert.equal(spy.creates, 0);
});

test("a cancel-at-period-end row with no activeTo counts as provisioned", async (t) => {
  resetPlanKeyCacheForTests();
  t.after(() => resetPlanKeyCacheForTests());

  // Konnect Metering & Billing v3 omits activeTo entirely.
  const occupying = await findSlotOccupyingSubscription(
    clientWithRows(
      [
        {
          id: "01KZCN0AH450JWA381D2AN7NJK",
          status: "canceled",
          customer_id: "01KZCM0S8FNE1TF9ECKF5RA8VP",
          plan: { id: "01KZA99BCTE062Y562VGRSJ6EP" },
          billing_anchor: "2026-08-06T23:02:17.378589Z",
        },
      ],
      undefined,
      { "01KZA99BCTE062Y562VGRSJ6EP": STARTER_PLAN_KEY },
    ) as never,
    "01KZCM0S8FNE1TF9ECKF5RA8VP",
  );

  assert.equal(occupying?.id, "01KZCN0AH450JWA381D2AN7NJK");
});

test("a genuinely unprovisioned customer reports no slot holder", async (t) => {
  resetPlanKeyCacheForTests();
  t.after(() => resetPlanKeyCacheForTests());

  assert.equal(
    await findSlotOccupyingSubscription(clientWithRows([]) as never, "cust_new"),
    null,
  );
  // An already-ended row leaves the slot free, so a create is still correct.
  assert.equal(
    await findSlotOccupyingSubscription(
      clientWithRows([
        {
          id: "ended_starter",
          status: "inactive",
          customer_id: "cust_new",
          plan: { key: STARTER_PLAN_KEY },
          active_to: "2026-01-01T00:00:00.000Z",
        },
      ]) as never,
      "cust_new",
    ),
    null,
  );
});

test("create conflict recovers to the occupying row instead of rethrowing", async (t) => {
  resetPlanKeyCacheForTests();
  t.after(() => resetPlanKeyCacheForTests());

  const spy = { creates: 0 };
  const provisioned = await createStarterSubscriptionWithBillingRecovery({
    client: clientWithRows(UPGRADED_OFF_STARTER_ROWS, spy) as never,
    customerId: "01KZF91HX8XSX4WMP1N4VXNWZ4",
    starter: { openmeterPlanId: "01KZA99BCTE062Y562VGRSJ6EP" } as never,
    planKey: STARTER_PLAN_KEY,
  });

  assert.equal(provisioned.subscription.id, "01KZFG1WS3AEZX6E59H7VBWNQN");
  assert.equal(provisioned.created, false);
  // Exactly one attempt — recovery must not retry the create.
  assert.equal(spy.creates, 1);
});

test("a conflict with no occupying row rethrows naming customer and plan", async (t) => {
  resetPlanKeyCacheForTests();
  t.after(() => resetPlanKeyCacheForTests());

  await assert.rejects(
    createStarterSubscriptionWithBillingRecovery({
      client: clientWithRows([], { creates: 0 }) as never,
      customerId: "01KZF91HX8XSX4WMP1N4VXNWZ4",
      starter: { openmeterPlanId: "01KZA99BCTE062Y562VGRSJ6EP" } as never,
      planKey: STARTER_PLAN_KEY,
    }),
    (err: Error) => {
      assert.match(err.message, /01KZF91HX8XSX4WMP1N4VXNWZ4/);
      assert.match(err.message, new RegExp(STARTER_PLAN_KEY));
      // Keeps the upstream text so isOpenMeterConflictError still classifies it.
      assert.match(err.message, /\b409\b/);
      return true;
    },
  );
});

test("recoverStarterBillingProfile pins Custom Invoicing for merchant apps", async () => {
  const { recoverStarterBillingProfile } = await import(
    "@/lib/openmeter/starter-subscription"
  );
  const prepareCalls: string[] = [];
  const freeCalls: string[] = [];
  const mode = await recoverStarterBillingProfile(
    {
      client: {} as never,
      customerId: "cust_m",
      clientId: "app_m",
    },
    {
      getConfig: async () =>
        ({ billingMode: "merchant" }) as never,
      prepareMerchant: async (input) => {
        prepareCalls.push(input.customerId);
      },
      applyFree: async (input) => {
        freeCalls.push(input.customerId);
      },
    },
  );
  assert.equal(mode, "merchant");
  assert.deepEqual(prepareCalls, ["cust_m"]);
  assert.deepEqual(freeCalls, []);
});

test("recoverStarterBillingProfile uses sandbox free profile otherwise", async () => {
  const { recoverStarterBillingProfile } = await import(
    "@/lib/openmeter/starter-subscription"
  );
  const prepareCalls: string[] = [];
  const freeCalls: string[] = [];
  const mode = await recoverStarterBillingProfile(
    {
      client: {} as never,
      customerId: "cust_f",
      clientId: "app_f",
    },
    {
      getConfig: async () =>
        ({ billingMode: "owner_rollup" }) as never,
      prepareMerchant: async (input) => {
        prepareCalls.push(input.customerId);
      },
      applyFree: async (input) => {
        freeCalls.push(input.customerId);
      },
    },
  );
  assert.equal(mode, "free");
  assert.deepEqual(prepareCalls, []);
  assert.deepEqual(freeCalls, ["cust_f"]);
});
