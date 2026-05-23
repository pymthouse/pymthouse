import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import { run } from "@/test-utils/db-guard";
import {
  basicAuthHeader,
  cleanupTestApp,
  createAppUser,
  seedDeveloperAppWithClient,
} from "@/test-utils/fixtures";

async function seedUsage(opts: {
  clientId: string;
  userId: string | null;
  feeWei: bigint;
  units?: bigint;
  createdAt?: string;
  requestId?: string;
}): Promise<string> {
  const { db } = await import("@/db/index");
  const { usageRecords } = await import("@/db/schema");
  const id = randomUUID();
  await db.insert(usageRecords).values({
    id,
    requestId: opts.requestId ?? randomUUID(),
    clientId: opts.clientId,
    userId: opts.userId,
    units: (opts.units ?? 1n).toString(),
    fee: opts.feeWei.toString(),
    createdAt: opts.createdAt ?? new Date().toISOString(),
  });
  return id;
}

async function seedUsageBillingEvent(opts: {
  usageRecordId: string;
  clientId: string;
  userId: string | null;
  pipeline: string;
  modelId: string;
  gatewayRequestId: string;
  networkFeeWei: bigint;
  networkFeeUsdMicros: bigint;
  ownerChargeUsdMicros: bigint;
  upchargePercentBps: number;
  pricingRuleSource: string;
  endUserBillableUsdMicros: bigint;
}) {
  const { db } = await import("@/db/index");
  const { usageBillingEvents } = await import("@/db/schema");
  await db.insert(usageBillingEvents).values({
    id: randomUUID(),
    usageRecordId: opts.usageRecordId,
    clientId: opts.clientId,
    userId: opts.userId,
    pipeline: opts.pipeline,
    modelId: opts.modelId,
    attributionSource: "pymthouse_gateway",
    gatewayRequestId: opts.gatewayRequestId,
    paymentMetadataVersion: "2026-04-usage-attribution-v1",
    pipelineModelConstraintHash: randomUUID().replace(/-/g, ""),
    orchAddress: "0x000102030405060708090a0b0c0d0e0f10111213",
    advertisedPriceWeiPerUnit: "1000000000",
    advertisedPixelsPerUnit: "1",
    signedPriceWeiPerUnit: "1000000000",
    signedPixelsPerUnit: "1",
    networkFeeWei: opts.networkFeeWei.toString(),
    networkFeeUsdMicros: opts.networkFeeUsdMicros.toString(),
    platformFeeWei: "0",
    platformFeeUsdMicros: "0",
    ownerChargeWei: opts.networkFeeWei.toString(),
    ownerChargeUsdMicros: opts.ownerChargeUsdMicros.toString(),
    upchargePercentBps: opts.upchargePercentBps,
    pricingRuleSource: opts.pricingRuleSource,
    endUserBillableUsdMicros: opts.endUserBillableUsdMicros.toString(),
    ethUsdPrice: "3000",
    ethUsdSource: "default",
    ethUsdObservedAt: "2026-06-01T00:00:00.000Z",
    createdAt: "2026-06-01T00:00:00.000Z",
  });
}

run("usage API requires a matching client or authorized session", async (t) => {
  const { GET } = await import("./route");
  const app = await seedDeveloperAppWithClient({ status: "approved" });
  t.after(() => cleanupTestApp(app));

  // No auth -> 404 (handler deliberately opaque).
  const anonymous = await GET(
    new Request(`http://localhost/api/v1/apps/${app.clientId}/usage`) as never,
    { params: Promise.resolve({ id: app.clientId }) },
  );
  assert.equal(anonymous.status, 404);

  // Wrong secret -> 404.
  const wrong = await GET(
    new Request(`http://localhost/api/v1/apps/${app.clientId}/usage`, {
      headers: { Authorization: basicAuthHeader(app.clientId, "pmth_cs_nope") },
    }) as never,
    { params: Promise.resolve({ id: app.clientId }) },
  );
  assert.equal(wrong.status, 404);

  // Basic auth for client A cannot read client B's usage.
  const other = await seedDeveloperAppWithClient({ status: "approved" });
  t.after(() => cleanupTestApp(other));
  const crossTenant = await GET(
    new Request(`http://localhost/api/v1/apps/${other.clientId}/usage`, {
      headers: { Authorization: basicAuthHeader(app.clientId, app.clientSecret) },
    }) as never,
    { params: Promise.resolve({ id: other.clientId }) },
  );
  assert.equal(crossTenant.status, 404);

  // Correct Basic auth -> 200.
  const ok = await GET(
    new Request(`http://localhost/api/v1/apps/${app.clientId}/usage`, {
      headers: { Authorization: basicAuthHeader(app.clientId, app.clientSecret) },
    }) as never,
    { params: Promise.resolve({ id: app.clientId }) },
  );
  assert.equal(ok.status, 200);
});

run("usage API aggregates seeded rows, filters by date and user, and validates input", async (t) => {
  const { GET } = await import("./route");

  const app = await seedDeveloperAppWithClient({ status: "approved" });
  t.after(() => cleanupTestApp(app));

  const alpha = await createAppUser({
    clientId: app.clientId,
    externalUserId: "alpha-ext",
  });
  const beta = await createAppUser({
    clientId: app.clientId,
    externalUserId: "beta-ext",
  });

  const inside1 = "2026-06-01T00:00:00.000Z";
  const inside2 = "2026-06-15T00:00:00.000Z";
  const outside = "2020-01-01T00:00:00.000Z";

  await seedUsage({ clientId: app.clientId, userId: alpha.id, feeWei: 1_000_000_000_000_000n, createdAt: inside1 });
  await seedUsage({ clientId: app.clientId, userId: alpha.id, feeWei: 2_000_000_000_000_000n, createdAt: inside2 });
  await seedUsage({ clientId: app.clientId, userId: beta.id, feeWei: 500_000_000_000_000n, createdAt: inside1 });
  await seedUsage({ clientId: app.clientId, userId: null, feeWei: 10n, createdAt: inside2 });
  await seedUsage({ clientId: app.clientId, userId: alpha.id, feeWei: 7n, createdAt: outside });

  async function call(query = "") {
    const res = await GET(
      new Request(`http://localhost/api/v1/apps/${app.clientId}/usage${query}`, {
        headers: { Authorization: basicAuthHeader(app.clientId, app.clientSecret) },
      }) as never,
      { params: Promise.resolve({ id: app.clientId }) },
    );
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  }

  // Totals across all rows.
  const all = await call();
  assert.equal(all.status, 200);
  const allTotals = (all.body as {
    totals: { requestCount: number; currency: string; networkFeeUsdMicros: string };
  }).totals;
  assert.equal(allTotals.requestCount, 5);
  assert.equal(allTotals.currency, "USD");
  assert.equal(allTotals.networkFeeUsdMicros, "0");

  // Date-windowed totals exclude the "outside" row.
  const windowed = await call(`?startDate=2026-05-01T00:00:00.000Z&endDate=2026-07-01T00:00:00.000Z`);
  assert.equal(windowed.status, 200);
  const windowedTotals = (windowed.body as {
    totals: { requestCount: number; networkFeeUsdMicros: string };
  }).totals;
  assert.equal(windowedTotals.requestCount, 4);
  assert.equal(windowedTotals.networkFeeUsdMicros, "0");

  // userId filter narrows to one app_user.
  const betaOnly = await call(`?userId=${encodeURIComponent(beta.id)}`);
  assert.equal(betaOnly.status, 200);
  const betaTotals = (betaOnly.body as {
    totals: { requestCount: number; networkFeeUsdMicros: string };
  }).totals;
  assert.equal(betaTotals.requestCount, 1);
  assert.equal(betaTotals.networkFeeUsdMicros, "0");

  // groupBy=user exposes external ids and an "unknown" bucket for null user_id rows.
  const grouped = await call("?groupBy=user");
  const buckets = (grouped.body as {
    byUser: {
      endUserId: string;
      externalUserId: string | null;
      requestCount: number;
      currency: string;
      networkFeeUsdMicros: string;
    }[];
  }).byUser;
  assert.equal(buckets.length, 3);
  const byId = new Map(buckets.map((b) => [b.endUserId, b]));
  assert.equal(byId.get(alpha.id)!.externalUserId, "alpha-ext");
  assert.equal(byId.get(alpha.id)!.requestCount, 3);
  assert.equal(byId.get(beta.id)!.externalUserId, "beta-ext");
  assert.equal(byId.get("unknown")!.externalUserId, null);
  assert.equal(byId.get("unknown")!.requestCount, 1);

  // Input validation.
  const badStart = await call("?startDate=not-a-date");
  assert.equal(badStart.status, 400);
  const badEnd = await call("?endDate=still-not-a-date");
  assert.equal(badEnd.status, 400);
});

run("usage API groupBy=user resolves externalUserId from end_users for signer-session attribution", async (t) => {
  const { GET } = await import("./route");
  const { db } = await import("@/db/index");
  const { endUsers } = await import("@/db/schema");

  const app = await seedDeveloperAppWithClient({ status: "approved" });
  t.after(() => cleanupTestApp(app));

  const endUserPk = randomUUID();
  await db.insert(endUsers).values({
    id: endUserPk,
    appId: app.clientId,
    externalUserId: "naap-user-42",
    creditBalanceWei: "0",
  });

  await seedUsage({
    clientId: app.clientId,
    userId: endUserPk,
    feeWei: 99n,
    createdAt: "2026-06-10T00:00:00.000Z",
  });

  const res = await GET(
    new Request(
      `http://localhost/api/v1/apps/${app.clientId}/usage?groupBy=user&startDate=2026-06-01T00:00:00.000Z&endDate=2026-06-30T23:59:59.999Z`,
      { headers: { Authorization: basicAuthHeader(app.clientId, app.clientSecret) } },
    ) as never,
    { params: Promise.resolve({ id: app.clientId }) },
  );
  assert.equal(res.status, 200);
  const body = (await res.json()) as {
    byUser: { endUserId: string; externalUserId: string | null; requestCount: number }[];
  };
  const row = body.byUser?.find((b) => b.endUserId === endUserPk);
  assert.ok(row, "expected one byUser bucket keyed by end_users.id");
  assert.equal(row!.externalUserId, "naap-user-42");
  assert.equal(row!.requestCount, 1);
});

run("usage API groupBy=user preserves provider external ids stored on usage rows", async (t) => {
  const { GET } = await import("./route");
  const { db } = await import("@/db/index");
  const { endUsers } = await import("@/db/schema");

  const app = await seedDeveloperAppWithClient({ status: "approved" });
  t.after(() => cleanupTestApp(app));

  await db.insert(endUsers).values({
    id: randomUUID(),
    appId: app.clientId,
    externalUserId: "naap-user-direct",
    creditBalanceWei: "0",
  });

  await seedUsage({
    clientId: app.clientId,
    userId: "naap-user-direct",
    feeWei: 123n,
    createdAt: "2026-06-10T00:00:00.000Z",
  });

  const res = await GET(
    new Request(
      `http://localhost/api/v1/apps/${app.clientId}/usage?groupBy=user&startDate=2026-06-01T00:00:00.000Z&endDate=2026-06-30T23:59:59.999Z`,
      { headers: { Authorization: basicAuthHeader(app.clientId, app.clientSecret) } },
    ) as never,
    { params: Promise.resolve({ id: app.clientId }) },
  );
  assert.equal(res.status, 200);
  const body = (await res.json()) as {
    byUser: { endUserId: string; externalUserId: string | null; requestCount: number }[];
  };
  const row = body.byUser?.find((b) => b.endUserId === "naap-user-direct");
  assert.ok(row, "expected byUser bucket keyed by provider external id");
  assert.equal(row!.externalUserId, "naap-user-direct");
  assert.equal(row!.requestCount, 1);
});

run("usage API aggregates billing events by pipeline/model and exposes gateway request events", async (t) => {
  const { GET } = await import("./route");

  const app = await seedDeveloperAppWithClient({ status: "approved" });
  t.after(() => cleanupTestApp(app));

  const alpha = await createAppUser({
    clientId: app.clientId,
    externalUserId: "alpha-ext",
  });

  const textUsage1 = await seedUsage({
    clientId: app.clientId,
    userId: alpha.id,
    feeWei: 1_000n,
    requestId: "gw-alpha-1",
  });
  const textUsage2 = await seedUsage({
    clientId: app.clientId,
    userId: alpha.id,
    feeWei: 2_000n,
    requestId: "gw-alpha-2",
  });
  const llmUsage = await seedUsage({
    clientId: app.clientId,
    userId: null,
    feeWei: 3_000n,
    requestId: "gw-beta-1",
  });

  await seedUsageBillingEvent({
    usageRecordId: textUsage1,
    clientId: app.clientId,
    userId: alpha.id,
    pipeline: "text-to-image",
    modelId: "stabilityai/sdxl",
    gatewayRequestId: "gateway-alpha",
    networkFeeWei: 1_000n,
    networkFeeUsdMicros: 1_000_000n,
    ownerChargeUsdMicros: 1_150_000n,
    upchargePercentBps: 2000,
    pricingRuleSource: "general",
    endUserBillableUsdMicros: 1_200_000n,
  });
  await seedUsageBillingEvent({
    usageRecordId: textUsage2,
    clientId: app.clientId,
    userId: alpha.id,
    pipeline: "text-to-image",
    modelId: "stabilityai/sdxl",
    gatewayRequestId: "gateway-alpha",
    networkFeeWei: 2_000n,
    networkFeeUsdMicros: 2_000_000n,
    ownerChargeUsdMicros: 2_300_000n,
    upchargePercentBps: 5000,
    pricingRuleSource: "pipeline_model",
    endUserBillableUsdMicros: 3_000_000n,
  });
  await seedUsageBillingEvent({
    usageRecordId: llmUsage,
    clientId: app.clientId,
    userId: null,
    pipeline: "llm",
    modelId: "openai-chat-completions",
    gatewayRequestId: "gateway-beta",
    networkFeeWei: 3_000n,
    networkFeeUsdMicros: 3_000_000n,
    ownerChargeUsdMicros: 3_000_000n,
    upchargePercentBps: 0,
    pricingRuleSource: "unpriced",
    endUserBillableUsdMicros: 3_000_000n,
  });

  async function call(query = "") {
    const res = await GET(
      new Request(`http://localhost/api/v1/apps/${app.clientId}/usage${query}`, {
        headers: { Authorization: basicAuthHeader(app.clientId, app.clientSecret) },
      }) as never,
      { params: Promise.resolve({ id: app.clientId }) },
    );
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  }

  const overall = await call();
  assert.equal(overall.status, 200);
  const totals = (overall.body as {
    totals: {
      requestCount: number;
      networkFeeUsdMicros: string;
      ownerChargeUsdMicros: string;
      endUserBillableUsdMicros: string;
    };
  }).totals;
  assert.equal(totals.requestCount, 3);
  assert.equal(totals.networkFeeUsdMicros, "6000000");
  assert.equal(totals.ownerChargeUsdMicros, "6450000");
  assert.equal(totals.endUserBillableUsdMicros, "7200000");

  const grouped = await call("?groupBy=pipeline_model");
  assert.equal(grouped.status, 200);
  const byPipelineModel = (grouped.body as {
    byPipelineModel: Array<{
      pipeline: string;
      modelId: string;
      currency: string;
      requestCount: number;
      networkFeeUsdMicros: string;
      ownerChargeUsdMicros: string;
      endUserBillableUsdMicros: string;
    }>;
  }).byPipelineModel;
  assert.equal(byPipelineModel.length, 2);
  const groupedByKey = new Map(
    byPipelineModel.map((row) => [`${row.pipeline}|${row.modelId}`, row]),
  );
  assert.deepEqual(groupedByKey.get("text-to-image|stabilityai/sdxl"), {
    pipeline: "text-to-image",
    modelId: "stabilityai/sdxl",
    currency: "USD",
    requestCount: 2,
    networkFeeUsdMicros: "3000000",
    ownerChargeUsdMicros: "3450000",
    endUserBillableUsdMicros: "4200000",
  });
  assert.deepEqual(groupedByKey.get("llm|openai-chat-completions"), {
    pipeline: "llm",
    modelId: "openai-chat-completions",
    currency: "USD",
    requestCount: 1,
    networkFeeUsdMicros: "3000000",
    ownerChargeUsdMicros: "3000000",
    endUserBillableUsdMicros: "3000000",
  });

  const gatewayEvents = await call("?gatewayRequestId=gateway-alpha");
  assert.equal(gatewayEvents.status, 200);
  const events = (gatewayEvents.body as {
    events: Array<{
      gatewayRequestId: string;
      pipeline: string;
      modelId: string;
      upchargePercentBps: number;
      pricingRuleSource: string;
      endUserBillableUsdMicros: string;
    }>;
  }).events;
  assert.equal(events.length, 2);
  assert.ok(events.every((event) => event.gatewayRequestId === "gateway-alpha"));
  assert.ok(events.every((event) => event.pipeline === "text-to-image"));
  assert.deepEqual(
    events
      .map((event) => ({
        modelId: event.modelId,
        upchargePercentBps: event.upchargePercentBps,
        pricingRuleSource: event.pricingRuleSource,
        endUserBillableUsdMicros: event.endUserBillableUsdMicros,
      }))
      .sort((a, b) => a.upchargePercentBps - b.upchargePercentBps),
    [
      {
        modelId: "stabilityai/sdxl",
        upchargePercentBps: 2000,
        pricingRuleSource: "general",
        endUserBillableUsdMicros: "1200000",
      },
      {
        modelId: "stabilityai/sdxl",
        upchargePercentBps: 5000,
        pricingRuleSource: "pipeline_model",
        endUserBillableUsdMicros: "3000000",
      },
    ],
  );
});
