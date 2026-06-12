import test from "node:test";
import assert from "node:assert/strict";

import { unwrapOpenMeterListResult } from "./konnect-catalog";
import {
  buildKonnectUsageRateCard,
  rewriteKonnectPlanRequestBody,
} from "./konnect-plan-body";
import {
  normalizeKonnectListResponse,
  normalizeKonnectSubscriptionRecord,
  rewriteKonnectPathname,
  rewriteKonnectRequestBody,
  rewriteKonnectRequestUrl,
} from "./konnect-routes";

test("rewriteKonnectPathname strips api version prefix", () => {
  assert.equal(
    rewriteKonnectPathname("/v3/openmeter/api/v1/customers", "POST"),
    "/v3/openmeter/customers",
  );
  assert.equal(
    rewriteKonnectPathname(
      "/v3/openmeter/api/v2/customers/app_1:user_1/entitlements/network_spend/value",
      "GET",
    ),
    "/v3/openmeter/customers/app_1:user_1/entitlements/network_spend/value",
  );
});

test("rewriteKonnectPathname maps billing profile and customer override paths", () => {
  assert.equal(
    rewriteKonnectPathname("/v3/openmeter/api/v1/billing/profiles", "POST"),
    "/v3/openmeter/profiles",
  );
  assert.equal(
    rewriteKonnectPathname("/v3/openmeter/api/v1/billing/customers/cust_1", "PUT"),
    "/v3/openmeter/customers/cust_1/billing",
  );
});

test("rewriteKonnectRequestUrl maps customer subscriptions to filtered list", () => {
  const url = new URL(
    "https://us.api.konghq.com/v3/openmeter/api/v1/customers/cust_1/subscriptions?pageSize=100",
  );
  const rewritten = rewriteKonnectRequestUrl(url, "GET");
  assert.equal(rewritten.pathname, "/v3/openmeter/subscriptions");
  assert.equal(rewritten.searchParams.get("filter[customer_id][eq]"), "cust_1");
  assert.equal(rewritten.searchParams.get("page[size]"), "100");
});

test("unwrapOpenMeterListResult accepts arrays and Konnect page envelopes", () => {
  assert.deepEqual(unwrapOpenMeterListResult([{ id: "1" }]), [{ id: "1" }]);
  assert.deepEqual(unwrapOpenMeterListResult({ data: [{ id: "2" }] }), [{ id: "2" }]);
  assert.deepEqual(unwrapOpenMeterListResult({ items: [{ id: "3" }] }), [{ id: "3" }]);
  assert.deepEqual(unwrapOpenMeterListResult({}), []);
});

test("rewriteKonnectPlanRequestBody maps plan phases to Konnect snake_case", () => {
  const rewritten = rewriteKonnectPlanRequestBody({
    key: "starter",
    billingCadence: "P1M",
    phases: [
      {
        key: "default",
        name: "Default",
        duration: null,
        rateCards: [
          {
            type: "usage_based",
            key: "network_spend",
            name: "Network usage",
            featureKey: "network_spend",
            billingCadence: "P1M",
            price: { type: "unit", amount: "0.000001" },
          },
        ],
      },
    ],
  }) as {
    billing_cadence: string;
    phases: Array<{ duration?: string | null; rate_cards: Array<Record<string, unknown>> }>;
  };

  assert.equal(rewritten.billing_cadence, "P1M");
  assert.equal(rewritten.phases[0]?.duration, undefined);
  assert.equal(rewritten.phases[0]?.rate_cards[0]?.feature_key, undefined);
  assert.deepEqual(rewritten.phases[0]?.rate_cards[0]?.feature, { key: "network_spend" });
});

test("rewriteKonnectRequestBody rewrites plan PUT bodies", () => {
  const rewritten = rewriteKonnectRequestBody(
    "/v3/openmeter/api/v1/plans/plan_1",
    "PUT",
    {
      billingCadence: "P1M",
      phases: [{ key: "default", name: "Default", duration: null, rateCards: [] }],
    },
  ) as { billing_cadence: string; phases: Array<{ rate_cards: unknown[] }> };

  assert.equal(rewritten.billing_cadence, "P1M");
  assert.ok(Array.isArray(rewritten.phases[0]?.rate_cards));
});

test("rewriteKonnectRequestBody maps customerId to nested customer for subscription create", () => {
  const rewritten = rewriteKonnectRequestBody(
    "/v3/openmeter/api/v1/subscriptions",
    "POST",
    {
      customerId: "cust_1",
      plan: { key: "starter" },
    },
  ) as { customer: { id: string }; plan: { key: string }; customerId?: string };

  assert.deepEqual(rewritten.customer, { id: "cust_1" });
  assert.equal(rewritten.plan.key, "starter");
  assert.equal(rewritten.customerId, undefined);
});

test("rewriteKonnectRequestBody leaves body unchanged when customer already present", () => {
  const body = {
    customer: { key: "app_1:user_1" },
    plan: { key: "starter" },
  };
  const rewritten = rewriteKonnectRequestBody(
    "/v3/openmeter/subscriptions",
    "POST",
    body,
  );
  assert.deepEqual(rewritten, body);
});

test("normalizeKonnectListResponse maps data to items", () => {
  const normalized = normalizeKonnectListResponse({
    data: [{ id: "1" }],
    meta: { page: { number: 1, size: 1 } },
  }) as { items: Array<{ id: string }> };
  assert.equal(normalized.items[0]?.id, "1");
});

test("normalizeKonnectSubscriptionRecord maps plan_id to plan.id", () => {
  const normalized = normalizeKonnectSubscriptionRecord({
    id: "01KTYQQTXB2R0EG6BVG5VZ9ZR1",
    status: "active",
    plan_id: "01KTYQQTGMZXR2TH3NZC4BY6JZ",
  }) as { plan?: { id?: string }; plan_id?: string };
  assert.equal(normalized.plan?.id, "01KTYQQTGMZXR2TH3NZC4BY6JZ");
  assert.equal(normalized.plan_id, undefined);
});

test("buildKonnectUsageRateCard applies included usage discounts", () => {
  const card = buildKonnectUsageRateCard({
    key: "network_spend",
    name: "Network usage",
    featureId: "01G65Z755AFWAKHE12NY0CQ9FH",
    unitAmount: "0.000001",
    includedMicros: 5_000_000,
  });
  assert.deepEqual(card.discounts, { usage: "5000000" });
});
