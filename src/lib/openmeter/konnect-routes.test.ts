import test from "node:test";
import assert from "node:assert/strict";

import { unwrapOpenMeterListResult } from "./konnect-catalog";
import {
  buildKonnectUsageRateCard,
  deepCamelToSnake,
  rewriteKonnectPlanRequestBody,
} from "./konnect-plan-body";
import {
  buildKonnectMeterQueryBody,
  isKonnectMeterQueryGet,
  mapKonnectMeterGranularity,
  normalizeKonnectMeterQueryResponse,
  normalizeKonnectListResponse,
  normalizeKonnectSubscriptionRecord,
  rewriteKonnectPathname,
  rewriteKonnectRequestBody,
  rewriteKonnectRequestUrl,
} from "./konnect-routes";
import { createKonnectFetch } from "./konnect-fetch";

const KONNECT_BASE = "https://metering.konghq.com/v3/openmeter";

function fetchTargetUrl(input: Parameters<typeof fetch>[0]): string {
  if (input instanceof Request) {
    return input.url;
  }
  return input.toString();
}

test("createKonnectFetch blocks requests to non-metering origins (SSRF guard)", async () => {
  const konnectFetch = createKonnectFetch(KONNECT_BASE);
  await assert.rejects(
    () => konnectFetch("https://evil.example.com/v3/openmeter/meters/m1", { method: "GET" }),
    /unexpected origin/,
  );
});

test("createKonnectFetch only ever calls fetch on the configured metering origin", async (t) => {
  const calls: URL[] = [];
  t.mock.method(globalThis, "fetch", async (input: Parameters<typeof fetch>[0]) => {
    calls.push(new URL(fetchTargetUrl(input)));
    return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
  });

  const konnectFetch = createKonnectFetch(KONNECT_BASE);
  await konnectFetch(`${KONNECT_BASE}/api/v1/customers`, { method: "GET" });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].origin, "https://metering.konghq.com");
});

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

test("rewriteKonnectRequestUrl maps events.list subject/limit/from/to to Konnect filters", () => {
  const url = new URL(
    "https://us.api.konghq.com/v3/openmeter/api/v1/events?subject=uuid-owner-1&limit=50&from=2026-07-01T00:00:00.000Z&to=2026-07-31T23:59:59.999Z",
  );
  const rewritten = rewriteKonnectRequestUrl(url, "GET");
  assert.equal(rewritten.pathname, "/v3/openmeter/events");
  assert.equal(rewritten.searchParams.get("filter[subject][eq]"), "uuid-owner-1");
  assert.equal(rewritten.searchParams.get("page[size]"), "50");
  assert.equal(
    rewritten.searchParams.get("filter[time][gte]"),
    "2026-07-01T00:00:00.000Z",
  );
  assert.equal(
    rewritten.searchParams.get("filter[time][lte]"),
    "2026-07-31T23:59:59.999Z",
  );
  assert.equal(rewritten.searchParams.get("subject"), null);
  assert.equal(rewritten.searchParams.get("limit"), null);
  assert.equal(rewritten.searchParams.get("from"), null);
  assert.equal(rewritten.searchParams.get("to"), null);
});

test("rewriteKonnectRequestUrl maps multiple event subjects to oeq", () => {
  const url = new URL("https://us.api.konghq.com/v3/openmeter/api/v1/events");
  url.searchParams.append("subject", "uuid-1");
  url.searchParams.append("subject", "owner:uuid-1");
  url.searchParams.set("limit", "25");
  const rewritten = rewriteKonnectRequestUrl(url, "GET");
  assert.equal(
    rewritten.searchParams.get("filter[subject][oeq]"),
    "uuid-1,owner:uuid-1",
  );
  assert.equal(rewritten.searchParams.get("filter[subject][eq]"), null);
  assert.equal(rewritten.searchParams.get("page[size]"), "25");
});

test("unwrapOpenMeterListResult accepts arrays and Konnect page envelopes", () => {
  assert.deepEqual(unwrapOpenMeterListResult([{ id: "1" }]), [{ id: "1" }]);
  assert.deepEqual(unwrapOpenMeterListResult({ data: [{ id: "2" }] }), [{ id: "2" }]);
  assert.deepEqual(unwrapOpenMeterListResult({ items: [{ id: "3" }] }), [{ id: "3" }]);
  assert.deepEqual(unwrapOpenMeterListResult({}), []);
});

test("deepCamelToSnake handles circular references", () => {
  const circular: Record<string, unknown> = { a: 1 };
  circular.self = circular;
  assert.deepEqual(deepCamelToSnake(circular), { a: 1, self: null });
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

test("rewriteKonnectRequestBody maps customer usageAttribution to snake_case", () => {
  const rewritten = rewriteKonnectRequestBody(
    "/v3/openmeter/api/v1/customers/cust_1",
    "PUT",
    {
      name: "owner:uuid-1",
      usageAttribution: { subjectKeys: ["owner:uuid-1", "app_1:uuid-1"] },
    },
  );
  assert.deepEqual(rewritten, {
    name: "owner:uuid-1",
    usage_attribution: {
      subject_keys: ["owner:uuid-1", "app_1:uuid-1"],
    },
  });
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

test("buildKonnectUsageRateCard includes usage discounts when provided", () => {
  const card = buildKonnectUsageRateCard({
    key: "network_spend",
    name: "Network usage",
    featureId: "01G65Z755AFWAKHE12NY0CQ9FH",
    unitAmount: "0.000001",
    includedUsdMicros: 5_000_000,
  });
  assert.deepEqual(card.discounts, { usage: "5000000" });
  assert.deepEqual(card.feature, { id: "01G65Z755AFWAKHE12NY0CQ9FH" });
  assert.deepEqual(card.price, { type: "unit", amount: "0.000001" });
});

test("buildKonnectUsageRateCard omits discounts when included amount is absent", () => {
  const card = buildKonnectUsageRateCard({
    key: "network_spend",
    name: "Network usage",
    featureId: "01G65Z755AFWAKHE12NY0CQ9FH",
    unitAmount: "0.000001",
  });
  assert.equal(card.discounts, undefined);
});

test("rewriteKonnectPlanRequestBody preserves rate card discounts", () => {
  const rewritten = rewriteKonnectPlanRequestBody({
    key: "starter",
    billingCadence: "P1M",
    phases: [
      {
        key: "default",
        name: "Default",
        rateCards: [
          {
            type: "usage_based",
            key: "network_spend",
            name: "Network usage",
            featureKey: "network_spend",
            billingCadence: "P1M",
            discounts: { usage: "5000000" },
            price: { type: "unit", amount: "0.000001" },
          },
        ],
      },
    ],
  }) as {
    phases: Array<{ rate_cards: Array<Record<string, unknown>> }>;
  };

  assert.deepEqual(rewritten.phases[0]?.rate_cards[0]?.discounts, { usage: "5000000" });
});

test("isKonnectMeterQueryGet detects SDK meter query GETs", () => {
  assert.equal(
    isKonnectMeterQueryGet(
      "/v3/openmeter/api/v1/meters/network_fee_usd_micros/query",
      "GET",
    ),
    true,
  );
  assert.equal(
    isKonnectMeterQueryGet(
      "/v3/openmeter/meters/network_fee_usd_micros/query",
      "POST",
    ),
    false,
  );
});

test("buildKonnectMeterQueryBody maps query string to Konnect POST body", () => {
  const params = new URLSearchParams();
  params.append("groupBy", "client_id");
  params.append("groupBy", "external_user_id");
  params.set("windowSize", "MONTH");
  params.set("subject", "app_1:user_1");
  params.set("from", "2026-06-01T00:00:00.000Z");
  params.set("to", "2026-06-12T00:00:00.000Z");
  params.set("clientId", "app_1");

  assert.deepEqual(buildKonnectMeterQueryBody(params), {
    group_by_dimensions: ["client_id", "external_user_id"],
    granularity: "P1M",
    from: "2026-06-01T00:00:00.000Z",
    to: "2026-06-12T00:00:00.000Z",
    filters: {
      dimensions: {
        subject: { eq: "app_1:user_1" },
        client_id: { eq: "app_1" },
      },
    },
  });
});

test("mapKonnectMeterGranularity maps SDK window sizes", () => {
  assert.equal(mapKonnectMeterGranularity("MONTH"), "P1M");
  assert.equal(mapKonnectMeterGranularity("DAY"), "P1D");
  assert.equal(mapKonnectMeterGranularity("HOUR"), "PT1H");
});

test("normalizeKonnectMeterQueryResponse maps dimensions to groupBy", () => {
  const normalized = normalizeKonnectMeterQueryResponse({
    data: [
      {
        dimensions: { client_id: "app_1", external_user_id: "user_1" },
        from: "2026-06-01T00:00:00.000Z",
        to: "2026-06-02T00:00:00.000Z",
        value: "1500",
      },
    ],
    from: "2026-06-01T00:00:00.000Z",
    to: "2026-06-02T00:00:00.000Z",
  }) as {
    data: Array<{
      groupBy: Record<string, string>;
      windowStart: string;
      windowEnd: string;
      value: number;
    }>;
  };

  assert.deepEqual(normalized.data[0]?.groupBy, {
    client_id: "app_1",
    external_user_id: "user_1",
  });
  assert.equal(normalized.data[0]?.windowStart, "2026-06-01T00:00:00.000Z");
  assert.equal(normalized.data[0]?.value, 1500);
});
