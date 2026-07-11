import test from "node:test";
import assert from "node:assert/strict";
import type { OpenMeter } from "@openmeter/sdk";

import { buildOpenMeterCustomerKey, parseOpenMeterCustomerKey } from "./customer-key";
import { ensureOpenMeterCustomer } from "./customers";
import { listTenantInvoices } from "./invoices";
import { mapPymthousePlanToOpenMeterCreate } from "./plans-sync";
import {
  isMintUserSignerTokenRequest,
  SIGN_MINT_USER_TOKEN_SCOPE,
} from "@/lib/oidc/mint-user-signer-token";
import { buildOpenMeterUsageResponse } from "@/lib/usage/query-openmeter";
import {
  aggregateDailyRequestCounts,
  aggregateDailyPipelineModelRows,
  aggregatePipelineModelRows,
  aggregateUserPipelineModelRows,
  dateKeyFromMeterWindow,
} from "@/lib/openmeter/usage-read";
import {
  isOpenMeterSubscriptionActive,
  verifyOpenMeterSubscriptionId,
} from "@/lib/openmeter/subscription-read";

function openMeterTestClient(mock: object): OpenMeter {
  return mock as OpenMeter;
}

function rateCardsFromPlanPhase(phase: {
  rateCards?: Array<Record<string, unknown>>;
  rate_cards?: Array<Record<string, unknown>>;
}): Array<Record<string, unknown>> {
  return phase.rateCards ?? phase.rate_cards ?? [];
}

test("buildOpenMeterCustomerKey encodes client and user", () => {
  const key = buildOpenMeterCustomerKey("app_abc", "user-123");
  assert.equal(key, "app_abc:user-123");
  const parsed = parseOpenMeterCustomerKey(key);
  assert.deepEqual(parsed, { clientId: "app_abc", externalUserId: "user-123" });
});

test("parseOpenMeterCustomerKey rejects malformed keys", () => {
  assert.equal(parseOpenMeterCustomerKey("no-colon"), null);
});

test("isMintUserSignerTokenRequest detects mint scope", () => {
  const params = new URLSearchParams({
    grant_type: "client_credentials",
    scope: SIGN_MINT_USER_TOKEN_SCOPE,
    external_user_id: "u1",
  });
  assert.equal(isMintUserSignerTokenRequest(params), true);
});

test("dateKeyFromMeterWindow returns UTC date key", () => {
  assert.equal(
    dateKeyFromMeterWindow({ windowStart: new Date("2026-05-06T15:00:00Z") }),
    "2026-05-06",
  );
});

test("aggregatePipelineModelRows sums fee and count by pipeline/model", () => {
  const rows = aggregatePipelineModelRows({
    clientId: "app_1",
    feeRows: [
      {
        value: 1_000_000, // nanos → 1000 micros
        windowStart: new Date("2026-05-01"),
        groupBy: {
          client_id: "app_1",
          pipeline: "text-to-image",
          model_id: "sdxl",
        },
      },
      {
        value: 500_000,
        windowStart: new Date("2026-05-01"),
        groupBy: {
          client_id: "app_1",
          pipeline: "text-to-image",
          model_id: "sdxl",
        },
      },
    ] as never,
    countRows: [
      {
        value: 2,
        windowStart: new Date("2026-05-01"),
        groupBy: {
          client_id: "app_1",
          pipeline: "text-to-image",
          model_id: "sdxl",
        },
      },
    ] as never,
  });
  assert.equal(rows.length, 1);
  const row = rows[0];
  assert.ok(row);
  assert.equal(row.pipeline, "text-to-image");
  assert.equal(row.requestCount, 2);
  assert.equal(row.networkFeeUsdMicros, "1500");
});

test("aggregateUserPipelineModelRows sums fee and count by user/pipeline/model", () => {
  const rows = aggregateUserPipelineModelRows({
    clientId: "app_1",
    feeRows: [
      {
        value: 1_000_000,
        windowStart: new Date("2026-05-01"),
        groupBy: {
          client_id: "app_1",
          external_user_id: "user-a",
          pipeline: "live-video-to-video",
          model_id: "streamdiffusion-sdxl",
        },
      },
      {
        value: 500_000,
        windowStart: new Date("2026-05-01"),
        groupBy: {
          client_id: "app_1",
          external_user_id: "user-a",
          pipeline: "live-video-to-video",
          model_id: "unknown",
        },
      },
    ] as never,
    countRows: [
      {
        value: 300,
        windowStart: new Date("2026-05-01"),
        groupBy: {
          client_id: "app_1",
          external_user_id: "user-a",
          pipeline: "live-video-to-video",
          model_id: "streamdiffusion-sdxl",
        },
      },
      {
        value: 33,
        windowStart: new Date("2026-05-01"),
        groupBy: {
          client_id: "app_1",
          external_user_id: "user-a",
          pipeline: "live-video-to-video",
          model_id: "unknown",
        },
      },
    ] as never,
  });
  assert.equal(rows.length, 2);
  const sdxl = rows.find((row) => row.modelId === "streamdiffusion-sdxl");
  const unknown = rows.find((row) => row.modelId === "unknown");
  assert.ok(sdxl);
  assert.ok(unknown);
  assert.equal(sdxl.externalUserId, "user-a");
  assert.equal(sdxl.requestCount, 300);
  assert.equal(sdxl.networkFeeUsdMicros, "1000");
  assert.equal(unknown.requestCount, 33);
  assert.equal(unknown.networkFeeUsdMicros, "500");
});

test("aggregateDailyPipelineModelRows sums fee and count by pipeline/model/day", () => {
  const rows = aggregateDailyPipelineModelRows({
    clientId: "app_1",
    feeRows: [
      {
        value: 100_000,
        windowStart: new Date("2026-06-02T00:00:00Z"),
        groupBy: {
          client_id: "app_1",
          pipeline: "live-video-to-video",
          model_id: "streamdiffusion",
        },
      },
    ] as never,
    countRows: [
      {
        value: 5,
        windowStart: new Date("2026-06-02T00:00:00Z"),
        groupBy: {
          client_id: "app_1",
          pipeline: "live-video-to-video",
          model_id: "streamdiffusion",
        },
      },
      {
        value: 14,
        windowStart: new Date("2026-06-03T00:00:00Z"),
        groupBy: {
          client_id: "app_1",
          pipeline: "live-video-to-video",
          model_id: "streamdiffusion",
        },
      },
    ] as never,
  });
  assert.equal(rows.length, 2);
  const first = rows[0];
  const second = rows[1];
  assert.ok(first && second);
  assert.equal(first.date, "2026-06-02");
  assert.equal(first.requestCount, 5);
  assert.equal(second.date, "2026-06-03");
  assert.equal(second.requestCount, 14);
});

test("aggregateDailyRequestCounts sums requests per day", () => {
  const byDay = aggregateDailyRequestCounts({
    clientId: "app_1",
    countRows: [
      {
        value: 3,
        windowStart: new Date("2026-05-06T00:00:00Z"),
        groupBy: { client_id: "app_1", external_user_id: "u1" },
      },
      {
        value: 2,
        windowStart: new Date("2026-05-06T00:00:00Z"),
        groupBy: { client_id: "app_1", external_user_id: "u2" },
      },
      {
        value: 1,
        windowStart: new Date("2026-05-07T00:00:00Z"),
        groupBy: { client_id: "app_1", external_user_id: "u1" },
      },
    ] as never,
  });
  assert.equal(byDay.get("2026-05-06"), 5);
  assert.equal(byDay.get("2026-05-07"), 1);
});

test("buildOpenMeterUsageResponse aggregates totals and byUser", () => {
  const response = buildOpenMeterUsageResponse({
    clientId: "app_1",
    startDate: "2026-01-01",
    endDate: "2026-01-31",
    groupBy: "user",
    rows: [
      {
        externalUserId: "u1",
        requestCount: 2,
        networkFeeUsdMicros: "1000",
      },
      {
        externalUserId: "u2",
        requestCount: 1,
        networkFeeUsdMicros: "500",
      },
    ],
  });
  const totals = response.totals;
  assert.ok(totals && typeof totals === "object");
  assert.equal((totals as { requestCount: number }).requestCount, 3);
  assert.equal((totals as { networkFeeUsdMicros: string }).networkFeeUsdMicros, "1500");
  assert.equal(Array.isArray(response.byUser) ? response.byUser.length : 0, 2);
});

test("buildOpenMeterUsageResponse does not copy network fee into endUserBillable", () => {
  const response = buildOpenMeterUsageResponse({
    clientId: "app_1",
    startDate: "2026-01-01",
    endDate: "2026-01-31",
    groupBy: "none",
    rows: [
      {
        externalUserId: "u1",
        requestCount: 1,
        networkFeeUsdMicros: "1000",
      },
    ],
  });
  const totals = response.totals as Record<string, unknown>;
  assert.equal(totals.networkFeeUsdMicros, "1000");
  assert.equal("endUserBillableUsdMicros" in totals, false);
});

test("ensureOpenMeterCustomer returns existing id and key", async () => {
  const client = {
    customers: {
      get: async (key: string) => ({
        id: "om-cust-1",
        key,
        usageAttribution: { subjectKeys: [key] },
      }),
      update: async () => {
        throw new Error("should not update when subject key present");
      },
      create: async () => {
        throw new Error("should not create");
      },
    },
  };

  const identity = await ensureOpenMeterCustomer(
    openMeterTestClient(client),
    "app_1:user-1",
    "User One",
  );
  assert.deepEqual(identity, { id: "om-cust-1", key: "app_1:user-1" });
});

test("ensureOpenMeterCustomer repairs missing usageAttribution subjectKeys", async () => {
  let updatedSubjectKeys: string[] | undefined;
  const client = {
    customers: {
      get: async (key: string) => ({
        id: "om-cust-1",
        key,
        usageAttribution: { subjectKeys: [] },
      }),
      update: async (_id: string, input: { usageAttribution: { subjectKeys: string[] } }) => {
        updatedSubjectKeys = input.usageAttribution.subjectKeys;
        return { id: "om-cust-1", key: "app_1:user-1" };
      },
      create: async () => {
        throw new Error("should not create");
      },
    },
  };

  const identity = await ensureOpenMeterCustomer(
    openMeterTestClient(client),
    "app_1:user-1",
    "User One",
  );
  assert.deepEqual(identity, { id: "om-cust-1", key: "app_1:user-1" });
  assert.deepEqual(updatedSubjectKeys, ["app_1:user-1"]);
});

test("ensureOpenMeterCustomer creates customer when missing", async () => {
  const client = {
    customers: {
      get: async () => {
        throw new Error("not found");
      },
      create: async (input: { key: string; name: string }) => ({
        id: "om-new",
        key: input.key,
      }),
    },
  };

  const identity = await ensureOpenMeterCustomer(openMeterTestClient(client), "app_1:user-2");
  assert.deepEqual(identity, { id: "om-new", key: "app_1:user-2" });
});

test("listTenantInvoices scopes billing.invoices.list to tenant customer ids", async () => {
  const listedCustomers: string[][] = [];
  const client = {
    customers: {
      list: async (input: { key: string; page: number; pageSize: number }) => ({
        items: [
          { id: "cust-a", key: "app_1:alpha" },
          { id: "cust-b", key: "app_1:beta" },
        ],
        page: input.page,
        pageSize: input.pageSize,
      }),
    },
    billing: {
      invoices: {
        list: async (input: { customers: string[] }) => {
          listedCustomers.push(input.customers);
          return {
            items: input.customers.map((customerId) => ({
              id: `inv-${customerId}`,
              status: "paid",
              currency: "USD",
              totals: { total: "10.00" },
              customer: { id: customerId, key: `${customerId}-key` },
            })),
          };
        },
      },
    },
  };

  const result = await listTenantInvoices({
    client: client as never,
    clientId: "app_1",
    page: 1,
    pageSize: 10,
  });

  assert.deepEqual(listedCustomers, [["cust-a", "cust-b"]]);
  assert.equal(result.items.length, 2);
  assert.equal(result.totalCount, 2);
});

test("mapPymthousePlanToOpenMeterCreate maps subscription flat fee and included allowance", async () => {
  const omPlan = await mapPymthousePlanToOpenMeterCreate({
    clientId: "app_1",
    plan: {
      id: "plan-1",
      clientId: "app_1",
      name: "Pro",
      type: "subscription",
      priceAmount: "29.00",
      priceCurrency: "USD",
      status: "active",
      includedUsdMicros: "5000000",
      overageRateUsd: "0.0000015",
      includedUnits: null,
      billingCycle: "monthly",
      discoveryProfileId: null,
      isNetworkDefault: false,
      isStarterDefault: false,
      discoveryExcludedCapabilities: null,
      openmeterPlanId: null,
      openmeterPlanVersion: null,
      lastSyncedAt: null,
      syncError: null,
      createdAt: "",
      updatedAt: "",
    },
    capabilities: [],
    client: {
      features: {
        list: async () => [],
        create: async () => ({}),
      },
    } as never,
  });

  assert.ok(omPlan);
  const { buildOpenMeterPlanKey } = await import("./plans-sync");
  const phase = omPlan.phases[0];
  assert.ok(phase);
  assert.equal(omPlan.key, buildOpenMeterPlanKey("app_1", "plan-1"));
  const phaseCards = rateCardsFromPlanPhase(phase);
  assert.equal(phaseCards.length, 2);
  const flatFee = phaseCards[0];
  const usage = phaseCards[1];
  assert.ok(flatFee && usage);
  assert.equal(flatFee.type, "flat_fee");
  assert.equal((flatFee as { price: { amount: string } }).price.amount, "29.00");
  assert.equal((usage as { price: { amount: string } }).price.amount, "0.0000015");
});

test("mapPymthousePlanToOpenMeterCreate adds per-capability usage rate cards", async () => {
  const createdFeatures: string[] = [];
  const omPlan = await mapPymthousePlanToOpenMeterCreate({
    clientId: "app_1",
    plan: {
      id: "plan-2",
      clientId: "app_1",
      name: "Usage",
      type: "usage",
      priceAmount: "0",
      priceCurrency: "USD",
      status: "active",
      includedUsdMicros: null,
      overageRateUsd: "0.000001",
      includedUnits: null,
      billingCycle: "monthly",
      discoveryProfileId: null,
      isNetworkDefault: false,
      isStarterDefault: false,
      discoveryExcludedCapabilities: null,
      openmeterPlanId: null,
      openmeterPlanVersion: null,
      lastSyncedAt: null,
      syncError: null,
      createdAt: "",
      updatedAt: "",
    },
    capabilities: [
      {
        id: "cap-1",
        planId: "plan-2",
        clientId: "app_1",
        pipeline: "text-to-image",
        modelId: "stabilityai/sdxl",
        slaTargetP95Ms: null,
        maxPricePerUnit: null,
        retailRateUsd: "0.000002",
        openmeterFeatureKey: null,
        createdAt: "",
      },
    ],
    client: {
      features: {
        list: async () => [],
        create: async (input: { key: string }) => {
          createdFeatures.push(input.key);
          return { key: input.key };
        },
      },
    } as never,
  });

  assert.ok(omPlan);
  const phase = omPlan.phases[0];
  assert.ok(phase);
  const capabilityCards = rateCardsFromPlanPhase(phase);
  assert.equal(capabilityCards.length, 1);
  assert.equal(createdFeatures.length, 1);
  const usage = capabilityCards[0];
  assert.ok(usage);
  assert.equal((usage as { price: { amount: string } }).price.amount, "0.000002");
});

test("isOpenMeterPlanNotFoundError detects stale plan id failures", async () => {
  const { isOpenMeterPlanNotFoundError } = await import("./plan-errors");
  assert.equal(isOpenMeterPlanNotFoundError(new Error("Plan not found")), true);
  assert.equal(isOpenMeterPlanNotFoundError({ status: 404 }), true);
  assert.equal(isOpenMeterPlanNotFoundError(new Error("validation failed")), false);
});

test("isOpenMeterConflictError detects duplicate entitlement failures", async () => {
  const { isOpenMeterConflictError } = await import("./plan-errors");
  assert.equal(
    isOpenMeterConflictError(
      new Error(
        "entitlement with id 01KSXHFE4BP5B9VEBKBKPZ10ZQ already exists for feature 01KSXCRRXRFM4MHJWT1SW8HASK",
      ),
    ),
    true,
  );
  assert.equal(isOpenMeterConflictError({ status: 409 }), true);
  assert.equal(isOpenMeterConflictError(new Error("validation failed")), false);
});

test("isOpenMeterStripeBillingError detects Stripe precondition failures on 409", async () => {
  const { isOpenMeterStripeBillingError, isOpenMeterConflictError } = await import("./plan-errors");
  const stripeErr = new Error(
    "conflict error: invalid billing setup: failed to get stripe customer data: " +
      "customer has no data for stripe app",
  );
  (stripeErr as { status: number }).status = 409;
  assert.equal(isOpenMeterStripeBillingError(stripeErr), true);
  assert.equal(isOpenMeterConflictError(stripeErr), true);

  const stripeMessageOnly = new Error(stripeErr.message);
  (stripeMessageOnly as { status: number }).status = 500;
  assert.equal(isOpenMeterStripeBillingError(stripeMessageOnly), false);
});

test("mapPymthousePlanToOpenMeterCreate skips network default plans", async () => {
  const omPlan = await mapPymthousePlanToOpenMeterCreate({
    clientId: "app_1",
    plan: {
      id: "default",
      clientId: "app_1",
      name: "Network Price",
      type: "usage",
      priceAmount: "0",
      priceCurrency: "USD",
      status: "active",
      includedUsdMicros: null,
      overageRateUsd: null,
      includedUnits: null,
      billingCycle: "monthly",
      discoveryProfileId: null,
      isNetworkDefault: true,
      isStarterDefault: false,
      discoveryExcludedCapabilities: null,
      openmeterPlanId: null,
      openmeterPlanVersion: null,
      lastSyncedAt: null,
      syncError: null,
      createdAt: "",
      updatedAt: "",
    },
    capabilities: [],
  });
  assert.equal(omPlan, null);
});

test("mapPymthousePlanToOpenMeterCreate maps Starter plan with network_spend entitlement", async () => {
  const omPlan = await mapPymthousePlanToOpenMeterCreate({
    clientId: "app_1",
    plan: {
      id: "starter-1",
      clientId: "app_1",
      name: "__pymthouse_starter__",
      type: "usage",
      priceAmount: "0",
      priceCurrency: "USD",
      status: "active",
      includedUsdMicros: "5000000",
      overageRateUsd: null,
      includedUnits: null,
      billingCycle: "monthly",
      discoveryProfileId: null,
      isNetworkDefault: false,
      isStarterDefault: true,
      discoveryExcludedCapabilities: null,
      openmeterPlanId: null,
      openmeterPlanVersion: null,
      lastSyncedAt: null,
      syncError: null,
      createdAt: "",
      updatedAt: "",
    },
    capabilities: [],
    client: {
      features: {
        list: async () => [],
        create: async () => ({}),
      },
    } as never,
  });

  assert.ok(omPlan);
  const phase = omPlan.phases[0];
  assert.ok(phase);
  const starterCards = rateCardsFromPlanPhase(phase);
  assert.equal(starterCards.length, 1);
  const usage = starterCards[0];
  assert.ok(usage);
  assert.equal(usage.key, "network_spend");
  assert.equal(usage.featureKey, "network_spend");
  assert.equal(
    (usage.entitlementTemplate as { issueAfterReset?: number } | undefined)
      ?.issueAfterReset,
    5_000_000_000,
  );
});

test("verifyOpenMeterSubscriptionId returns mapped subscription", async () => {
  const client = {
    subscriptions: {
      get: async (id: string) => ({
        id,
        status: "active",
        plan: { key: "app_1:plan_starter" },
        activeFrom: new Date("2026-01-01T00:00:00.000Z"),
        activeTo: new Date("2026-02-01T00:00:00.000Z"),
      }),
    },
  };

  const view = await verifyOpenMeterSubscriptionId(openMeterTestClient(client), "sub-1");
  assert.deepEqual(view, {
    id: "sub-1",
    status: "active",
    planKey: "app_1:plan_starter",
    planId: null,
    activeFrom: "2026-01-01T00:00:00.000Z",
    activeTo: "2026-02-01T00:00:00.000Z",
  });
});

test("verifyOpenMeterSubscriptionId returns null when remote subscription missing", async () => {
  const client = {
    subscriptions: {
      get: async () => {
        throw new Error("not found");
      },
    },
  };

  const view = await verifyOpenMeterSubscriptionId(openMeterTestClient(client), "missing");
  assert.equal(view, null);
});

test("isOpenMeterSubscriptionActive treats scheduled and pending as active", () => {
  assert.equal(isOpenMeterSubscriptionActive("active"), true);
  assert.equal(isOpenMeterSubscriptionActive("scheduled"), true);
  assert.equal(isOpenMeterSubscriptionActive("pending"), true);
  assert.equal(isOpenMeterSubscriptionActive("cancelled"), false);
});

test("verifyOpenMeterPlanId returns null for archived plans", async () => {
  const { verifyOpenMeterPlanId } = await import("./plans-sync");
  const client = {
    plans: {
      get: async () => ({
        id: "plan-archived",
        key: "app_1:starter",
        status: "archived",
      }),
    },
  };

  const view = await verifyOpenMeterPlanId(openMeterTestClient(client), "plan-archived");
  assert.equal(view, null);
});

test("verifyOpenMeterPlanId returns mapped plan", async () => {
  const { verifyOpenMeterPlanId } = await import("./plans-sync");
  const client = {
    plans: {
      get: async (id: string) => ({
        id,
        key: "app_1_plan_abc",
        status: "active",
      }),
    },
  };

  const view = await verifyOpenMeterPlanId(openMeterTestClient(client), "plan-1");
  assert.deepEqual(view, {
    id: "plan-1",
    key: "app_1_plan_abc",
    status: "active",
  });
});

test("verifyOpenMeterPlanId returns null when remote plan missing", async () => {
  const { verifyOpenMeterPlanId } = await import("./plans-sync");
  const client = {
    plans: {
      get: async () => {
        throw new Error("plan not found [404]");
      },
    },
  };

  const view = await verifyOpenMeterPlanId(openMeterTestClient(client), "missing");
  assert.equal(view, null);
});
