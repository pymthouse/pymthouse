import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import type { AuthResult } from "@/lib/auth";
import { validateBearerToken } from "@/lib/auth";
import { db } from "@/db/index";
import {
  endUsers,
  planCapabilityBundles,
  plans,
  streamSessions,
  usageIngestReceipts,
} from "@/db/schema";
import { proxyGenerateLivePayment } from "@/lib/signer-proxy";
import { resetEthUsdOracleCacheForTests } from "@/lib/prices/eth-usd-oracle";
import { run } from "@/test-utils/db-guard";
import {
  basicAuthHeader,
  cleanupTestApp,
  createAppUser,
  createJobTokenForApp,
  ensureRunningSigner,
  seedDeveloperAppWithClient,
} from "@/test-utils/fixtures";
import { mockSignerFetch } from "@/test-utils/mock-signer";
import { buildOrchestratorInfoBase64 } from "@/test-utils/orchestrator-info";
import { and, eq, isNotNull } from "drizzle-orm";

const PER_REQUEST_PIXELS = 1_000_000;
const PRICE_PER_UNIT = 1_000_000_000;
const PIXELS_PER_UNIT = 1;
const PER_REQUEST_FEE_WEI =
  (BigInt(PER_REQUEST_PIXELS) * BigInt(PRICE_PER_UNIT)) / BigInt(PIXELS_PER_UNIT);
/** Kept moderate so the suite stays fast on remote DBs; per-request fee is still huge for bigint totals. */
const VOLUME = 40;
const PIPELINE = "text-to-image";
const MODEL_ID = "stabilityai/sdxl";
const PAYMENT_METADATA_VERSION = "2026-04-usage-attribution-v1";

/**
 * Integration test:
 *   - Mock the remote signer at the `fetch` boundary.
 *   - Drive **`proxyGenerateLivePayment`** directly (same code as the HTTP route)
 *     with cached **`AuthResult`** from **`validateBearerToken`** — avoids Next
 *     request handling and repeated route auth on every iteration.
 *   - Validate persistence + bigint totals via **`GET /api/v1/apps/{id}/usage`**
 *     (Basic auth). Route-level auth for `generate-live-payment` is covered in
 *     **`proxy-routes.test.ts`**.
 */
run("high-volume signer usage is persisted and summarised via Usage API", async (t) => {
  resetEthUsdOracleCacheForTests();
  const { GET: readUsage } = await import("@/app/api/v1/apps/[id]/usage/route");
  const runId = randomUUID();

  const restoreSigner = await ensureRunningSigner();
  t.after(restoreSigner);

  const app = await seedDeveloperAppWithClient({ status: "approved" });
  t.after(() => cleanupTestApp(app));

  const ownerToken = await createJobTokenForApp({
    userId: app.userId,
    clientId: app.clientId,
    scopes: "sign:job",
  });

  const appUserAlpha = await createAppUser({
    clientId: app.clientId,
    externalUserId: "ext-alpha",
  });
  const appUserBeta = await createAppUser({
    clientId: app.clientId,
    externalUserId: "ext-beta",
  });
  const alphaToken = await createJobTokenForApp({
    userId: appUserAlpha.id,
    clientId: app.clientId,
    scopes: "sign:job",
  });
  const betaToken = await createJobTokenForApp({
    userId: appUserBeta.id,
    clientId: app.clientId,
    scopes: "sign:job",
  });

  const ownerAuth = await validateBearerToken(ownerToken);
  const alphaAuth = await validateBearerToken(alphaToken);
  const betaAuth = await validateBearerToken(betaToken);
  assert.ok(ownerAuth, "owner token resolves");
  assert.ok(alphaAuth, "alpha token resolves");
  assert.ok(betaAuth, "beta token resolves");

  const orch = await buildOrchestratorInfoBase64({
    pricePerUnit: PRICE_PER_UNIT,
    pixelsPerUnit: PIXELS_PER_UNIT,
  });

  const mock = mockSignerFetch({
    signerHost: "https://test-signer.invalid",
  });
  t.after(mock.restore);

  function paymentBody(requestId: string, manifestId: string): Record<string, unknown> {
    return {
      ManifestID: manifestId,
      RequestID: requestId,
      InPixels: PER_REQUEST_PIXELS,
      Orchestrator: orch,
      pipeline: PIPELINE,
      modelId: MODEL_ID,
      attributionSource: "pymthouse_gateway",
      gatewayRequestId: requestId,
      paymentMetadataVersion: PAYMENT_METADATA_VERSION,
    };
  }

  async function sendPayment(auth: AuthResult, requestId: string, manifestId: string) {
    const result = await proxyGenerateLivePayment(paymentBody(requestId, manifestId), auth);
    assert.equal(
      result.status,
      200,
      `proxyGenerateLivePayment expected 200, got ${result.status}: ${JSON.stringify(result.body)}`,
    );
  }

  // Distribute volume across: owner (no endUser), alpha, beta.
  const alphaCount = Math.floor(VOLUME * 0.4);
  const betaCount = Math.floor(VOLUME * 0.3);
  const ownerCount = VOLUME - alphaCount - betaCount;

  let successes = 0;

  for (let i = 0; i < ownerCount; i++) {
    await sendPayment(ownerAuth!, `${runId}-owner-req-${i}`, `${runId}-owner-manifest-${i}`);
    successes++;
  }
  for (let i = 0; i < alphaCount; i++) {
    await sendPayment(alphaAuth!, `${runId}-alpha-req-${i}`, `${runId}-alpha-manifest-${i}`);
    successes++;
  }
  for (let i = 0; i < betaCount; i++) {
    await sendPayment(betaAuth!, `${runId}-beta-req-${i}`, `${runId}-beta-manifest-${i}`);
    successes++;
  }

  assert.equal(successes, VOLUME);
  assert.equal(
    mock.calls.filter((c) => c.url.endsWith("/generate-live-payment")).length,
    VOLUME,
    "every payment should have been forwarded to the mocked signer exactly once",
  );

  // Idempotency / dedupe: re-sending the same requestId twice should not
  // produce additional usage rows.
  const dupeRequestId = `${runId}-dupe-req-0`;
  const dupeManifestId = `${runId}-dupe-manifest-0`;
  await sendPayment(ownerAuth!, dupeRequestId, dupeManifestId);
  await sendPayment(ownerAuth!, dupeRequestId, dupeManifestId);

  const expectedRequestCount = VOLUME + 1;

  const dupeSessionRows = await db
    .select()
    .from(streamSessions)
    .where(eq(streamSessions.manifestId, dupeManifestId))
    .limit(1);
  const dupeSession = dupeSessionRows[0];
  assert.ok(dupeSession, "stream session persisted for manifest");

  const dupeReceipts = await db
    .select()
    .from(usageIngestReceipts)
    .where(
      and(
        eq(usageIngestReceipts.clientId, app.clientId),
        eq(usageIngestReceipts.requestId, dupeRequestId),
      ),
    );
  assert.equal(
    dupeReceipts.length,
    1,
    "duplicate requestId should produce a single OpenMeter ingest receipt",
  );

  const activeSessions = await db
    .select({ id: streamSessions.id })
    .from(streamSessions)
    .where(
      and(eq(streamSessions.appId, app.clientId), isNotNull(streamSessions.lastPaymentAt)),
    );
  assert.ok(
    activeSessions.length > 0,
    "stream sessions should record lastPaymentAt after signer payment traffic",
  );

  async function fetchUsage(query = "") {
    const res = await readUsage(
      new Request(`http://localhost/api/v1/apps/${app.clientId}/usage${query}`, {
        method: "GET",
        headers: {
          Authorization: basicAuthHeader(app.clientId, app.clientSecret),
        },
      }) as never,
      { params: Promise.resolve({ id: app.clientId }) },
    );
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  }

  const overall = await fetchUsage();
  assert.equal(overall.status, 200);
  assert.equal((overall.body as { clientId: string }).clientId, app.clientId);
  const totals = (overall.body as {
    totals: { requestCount: number; currency: string; networkFeeUsdMicros: string };
  }).totals;
  assert.equal(totals.requestCount, expectedRequestCount, "one row per unique requestId");
  assert.equal(totals.currency, "USD");

  const byUser = await fetchUsage("?groupBy=user");
  assert.equal(byUser.status, 200);
  const buckets = (byUser.body as {
    byUser?: {
      endUserId: string;
      externalUserId: string | null;
      currency: string;
      networkFeeUsdMicros: string;
      requestCount: number;
    }[];
  }).byUser;
  assert.ok(Array.isArray(buckets), "byUser array present when groupBy=user");
  assert.equal(buckets!.length, 3, "three buckets: owner(user), alpha, beta");

  const alphaBucket = buckets!.find((b) => b.externalUserId === "ext-alpha");
  const betaBucket = buckets!.find((b) => b.externalUserId === "ext-beta");
  const ownerBucket = buckets!.find((b) => b.externalUserId === app.userId);

  assert.ok(alphaBucket, "alpha end user present in byUser");
  assert.equal(alphaBucket!.externalUserId, "ext-alpha");
  assert.equal(alphaBucket!.requestCount, alphaCount);
  assert.equal(alphaBucket!.currency, "USD");

  assert.ok(betaBucket, "beta end user present in byUser");
  assert.equal(betaBucket!.externalUserId, "ext-beta");
  assert.equal(betaBucket!.requestCount, betaCount);
  assert.equal(betaBucket!.currency, "USD");

  assert.ok(ownerBucket, "owner bucket uses platform user id as usage subject");
  assert.equal(ownerBucket!.requestCount, ownerCount + 1, "owner bucket includes dedup single row");

  // userId filter: only alpha rows.
  const alphaOnly = await fetchUsage(`?userId=${encodeURIComponent(appUserAlpha.externalUserId)}`);
  assert.equal(alphaOnly.status, 200);
  const alphaTotals = (alphaOnly.body as {
    totals: { requestCount: number; currency: string };
  }).totals;
  assert.equal(alphaTotals.requestCount, alphaCount);
  assert.equal(alphaTotals.currency, "USD");

  // Date window that excludes all rows -> zero totals.
  const emptyWindow = await fetchUsage(
    "?startDate=1970-01-01T00:00:00.000Z&endDate=1970-01-02T00:00:00.000Z",
  );
  assert.equal(emptyWindow.status, 200);
  const emptyTotals = (emptyWindow.body as {
    totals: { requestCount: number; networkFeeUsdMicros: string };
  }).totals;
  assert.equal(emptyTotals.requestCount, 0);
  assert.equal(emptyTotals.networkFeeUsdMicros, "0");

  // Invalid date parameter -> 400.
  const badDate = await readUsage(
    new Request(`http://localhost/api/v1/apps/${app.clientId}/usage?startDate=not-a-date`, {
      method: "GET",
      headers: {
        Authorization: basicAuthHeader(app.clientId, app.clientSecret),
      },
    }) as never,
    { params: Promise.resolve({ id: app.clientId }) },
  );
  assert.equal(badDate.status, 400);
});

run("BYOC preload payment creates first usage row for signer sessions", async (t) => {
  resetEthUsdOracleCacheForTests();
  const restoreSigner = await ensureRunningSigner();
  t.after(restoreSigner);

  const app = await seedDeveloperAppWithClient({ status: "approved" });
  t.after(() => cleanupTestApp(app));

  const endUserId = randomUUID();
  await db.insert(endUsers).values({
    id: endUserId,
    appId: app.clientId,
    externalUserId: "byoc-preload-user",
  });

  const token = await createJobTokenForApp({
    endUserId,
    clientId: app.clientId,
    scopes: "sign:job",
  });
  const auth = await validateBearerToken(token);
  assert.ok(auth, "signer session token resolves");

  const orch = await buildOrchestratorInfoBase64({
    pricePerUnit: PRICE_PER_UNIT,
    pixelsPerUnit: PIXELS_PER_UNIT,
  });
  const mock = mockSignerFetch({ signerHost: "https://test-signer.invalid" });
  t.after(mock.restore);

  const requestId = `byoc-preload-${randomUUID()}`;
  const manifestId = `job-${randomUUID()}`;
  const result = await proxyGenerateLivePayment(
    {
      type: "byoc",
      RequestID: requestId,
      manifestID: manifestId,
      preloadSeconds: 3,
      Orchestrator: orch,
      pipeline: "byoc",
    },
    auth!,
  );
  assert.equal(
    result.status,
    200,
    `proxyGenerateLivePayment expected 200, got ${result.status}: ${JSON.stringify(result.body)}`,
  );

  const sessionRows = await db
    .select()
    .from(streamSessions)
    .where(eq(streamSessions.manifestId, manifestId));
  assert.equal(sessionRows.length, 1);
  assert.equal(sessionRows[0]!.signerPaymentCount, 1);
});

run("successful zero-fee signer payment still increments usage count", async (t) => {
  resetEthUsdOracleCacheForTests();
  const restoreSigner = await ensureRunningSigner();
  t.after(restoreSigner);

  const app = await seedDeveloperAppWithClient({ status: "approved" });
  t.after(() => cleanupTestApp(app));

  const token = await createJobTokenForApp({
    userId: app.userId,
    clientId: app.clientId,
    scopes: "sign:job",
  });
  const auth = await validateBearerToken(token);
  assert.ok(auth, "signer token resolves");

  const mock = mockSignerFetch({ signerHost: "https://test-signer.invalid" });
  t.after(mock.restore);

  const requestId = `zero-fee-${randomUUID()}`;
  const result = await proxyGenerateLivePayment(
    {
      type: "byoc",
      RequestID: requestId,
      manifestID: `job-${randomUUID()}`,
      preloadSeconds: 3,
      pipeline: "byoc",
    },
    auth!,
  );
  assert.equal(
    result.status,
    200,
    `proxyGenerateLivePayment expected 200, got ${result.status}: ${JSON.stringify(result.body)}`,
  );

});

run("network cost usage applies retail rate from plan capability bundle", async (t) => {
  resetEthUsdOracleCacheForTests();
  const { GET: readUsage } = await import("@/app/api/v1/apps/[id]/usage/route");

  const restoreSigner = await ensureRunningSigner();
  t.after(restoreSigner);

  const app = await seedDeveloperAppWithClient({ status: "approved" });
  t.after(() => cleanupTestApp(app));

  const ownerToken = await createJobTokenForApp({
    userId: app.userId,
    clientId: app.clientId,
    scopes: "sign:job",
  });
  const ownerAuth = await validateBearerToken(ownerToken);
  assert.ok(ownerAuth, "owner token resolves");

  const planId = randomUUID();
  const now = new Date().toISOString();
  await db.insert(plans).values({
    id: planId,
    clientId: app.clientId,
    name: "Capability override plan",
    type: "usage",
    priceAmount: "0",
    priceCurrency: "USD",
    status: "active",
    createdAt: now,
    updatedAt: now,
  });
  await db.insert(planCapabilityBundles).values({
    id: randomUUID(),
    planId,
    clientId: app.clientId,
    pipeline: PIPELINE,
    modelId: MODEL_ID,
    retailRateUsd: "0.0000015",
    createdAt: now,
  });

  const orch = await buildOrchestratorInfoBase64({
    pricePerUnit: PRICE_PER_UNIT,
    pixelsPerUnit: PIXELS_PER_UNIT,
  });

  const mock = mockSignerFetch({
    signerHost: "https://test-signer.invalid",
  });
  t.after(mock.restore);

  const gatewayRequestId = `plan-upcharge-${randomUUID()}`;
  const result = await proxyGenerateLivePayment(
    {
      ManifestID: "plan-upcharge-manifest",
      RequestID: gatewayRequestId,
      InPixels: PER_REQUEST_PIXELS,
      Orchestrator: orch,
      pipeline: PIPELINE,
      modelId: MODEL_ID,
      attributionSource: "pymthouse_gateway",
      gatewayRequestId,
      paymentMetadataVersion: PAYMENT_METADATA_VERSION,
    },
    ownerAuth!,
  );
  assert.equal(
    result.status,
    200,
    `proxyGenerateLivePayment expected 200, got ${result.status}: ${JSON.stringify(result.body)}`,
  );

  const usage = await readUsage(
    new Request(
      `http://localhost/api/v1/apps/${app.clientId}/usage?groupBy=pipeline_model&userId=${encodeURIComponent(app.userId)}&includeRetail=1`,
      {
        method: "GET",
        headers: {
          Authorization: basicAuthHeader(app.clientId, app.clientSecret),
        },
      },
    ) as never,
    { params: Promise.resolve({ id: app.clientId }) },
  );
  assert.equal(usage.status, 200);
  const body = (await usage.json()) as {
    totals: { endUserBillableUsdMicros?: string; requestCount: number };
    byPipelineModel?: Array<{
      pipeline: string;
      modelId: string;
      networkFeeUsdMicros: string;
      retailRateUsd?: string;
      endUserBillableUsdMicros?: string;
    }>;
  };
  assert.equal(body.totals.requestCount, 1);
  const row = body.byPipelineModel?.find(
    (entry) => entry.pipeline === PIPELINE && entry.modelId === MODEL_ID,
  );
  assert.ok(row, "pipeline/model row present");
  assert.equal(row!.retailRateUsd, "0.0000015");
  assert.ok(row!.endUserBillableUsdMicros);
  assert.notEqual(row!.endUserBillableUsdMicros, row!.networkFeeUsdMicros);
});

run("proxy strips signer usage block and records signer_chainlink eth source", async (t) => {
  resetEthUsdOracleCacheForTests();
  const restoreSigner = await ensureRunningSigner();
  t.after(restoreSigner);

  const app = await seedDeveloperAppWithClient({ status: "approved" });
  t.after(() => cleanupTestApp(app));

  const ownerToken = await createJobTokenForApp({
    userId: app.userId,
    clientId: app.clientId,
    scopes: "sign:job",
  });
  const ownerAuth = await validateBearerToken(ownerToken);
  assert.ok(ownerAuth);

  const orch = await buildOrchestratorInfoBase64({
    pricePerUnit: PRICE_PER_UNIT,
    pixelsPerUnit: PIXELS_PER_UNIT,
  });

  const mock = mockSignerFetch({
    signerHost: "https://test-signer.invalid",
  });
  t.after(mock.restore);

  const gatewayRequestId = `signer-usage-${randomUUID()}`;
  const result = await proxyGenerateLivePayment(
    {
      ManifestID: "signer-usage-manifest",
      RequestID: gatewayRequestId,
      InPixels: PER_REQUEST_PIXELS,
      Orchestrator: orch,
      pipeline: PIPELINE,
      modelId: MODEL_ID,
      attributionSource: "pymthouse_gateway",
      gatewayRequestId,
      paymentMetadataVersion: PAYMENT_METADATA_VERSION,
    },
    ownerAuth!,
  );
  assert.equal(result.status, 200);
  assert.equal("usage" in (result.body as Record<string, unknown>), false);

  const receiptRows = await db
    .select()
    .from(usageIngestReceipts)
    .where(eq(usageIngestReceipts.requestId, gatewayRequestId))
    .limit(1);
  assert.equal(receiptRows.length, 1, "signed-ticket ingest receipt recorded");
});

run("generate-live-payment ingests negotiated ticket usage to OpenMeter", async (t) => {
  resetEthUsdOracleCacheForTests();
  const restoreSigner = await ensureRunningSigner();
  t.after(restoreSigner);

  const app = await seedDeveloperAppWithClient({ status: "approved" });
  t.after(() => cleanupTestApp(app));

  const ownerToken = await createJobTokenForApp({
    userId: app.userId,
    clientId: app.clientId,
    scopes: "sign:job",
  });
  const ownerAuth = await validateBearerToken(ownerToken);
  assert.ok(ownerAuth);

  const orch = await buildOrchestratorInfoBase64({
    pricePerUnit: PRICE_PER_UNIT,
    pixelsPerUnit: PIXELS_PER_UNIT,
  });

  const mock = mockSignerFetch({
    signerHost: "https://test-signer.invalid",
  });
  t.after(mock.restore);

  const gatewayRequestId = `negotiated-ticket-${randomUUID()}`;
  const result = await proxyGenerateLivePayment(
    {
      ManifestID: "negotiated-manifest",
      RequestID: gatewayRequestId,
      InPixels: PER_REQUEST_PIXELS,
      Orchestrator: orch,
      pipeline: PIPELINE,
      modelId: MODEL_ID,
      attributionSource: "pymthouse_gateway",
      gatewayRequestId,
      paymentMetadataVersion: PAYMENT_METADATA_VERSION,
    },
    ownerAuth!,
  );
  assert.equal(result.status, 200);

  assert.equal(
    mock.calls.filter((c) => c.url.endsWith("/generate-live-payment")).length,
    1,
  );

  const receiptRows = await db
    .select()
    .from(usageIngestReceipts)
    .where(eq(usageIngestReceipts.requestId, gatewayRequestId))
    .limit(1);
  assert.equal(receiptRows.length, 1, "usage ingest receipt recorded");

  const { GET: readUsage } = await import("@/app/api/v1/apps/[id]/usage/route");
  const usage = await readUsage(
    new Request(
      `http://localhost/api/v1/apps/${app.clientId}/usage?userId=${encodeURIComponent(app.userId)}`,
      {
        method: "GET",
        headers: {
          Authorization: basicAuthHeader(app.clientId, app.clientSecret),
        },
      },
    ),
    { params: Promise.resolve({ id: app.clientId }) },
  );
  assert.equal(usage.status, 200);
  const body = (await usage.json()) as { totals: { requestCount: number } };
  assert.equal(body.totals.requestCount, 1);
});

run("generate-live-payment ingests usage when modelId absent", async (t) => {
  resetEthUsdOracleCacheForTests();
  const restoreSigner = await ensureRunningSigner();
  t.after(restoreSigner);

  const app = await seedDeveloperAppWithClient({ status: "approved" });
  t.after(() => cleanupTestApp(app));

  const ownerToken = await createJobTokenForApp({
    userId: app.userId,
    clientId: app.clientId,
    scopes: "sign:job",
  });
  const ownerAuth = await validateBearerToken(ownerToken);
  assert.ok(ownerAuth);

  const orch = await buildOrchestratorInfoBase64({
    pricePerUnit: PRICE_PER_UNIT,
    pixelsPerUnit: PIXELS_PER_UNIT,
  });

  const mock = mockSignerFetch({
    signerHost: "https://test-signer.invalid",
  });
  t.after(mock.restore);

  const gatewayRequestId = `missing-constraint-${randomUUID()}`;
  const result = await proxyGenerateLivePayment(
    {
      ManifestID: "no-model-manifest",
      RequestID: gatewayRequestId,
      InPixels: PER_REQUEST_PIXELS,
      Orchestrator: orch,
      pipeline: PIPELINE,
      attributionSource: "pymthouse_gateway",
      gatewayRequestId,
      paymentMetadataVersion: PAYMENT_METADATA_VERSION,
    },
    ownerAuth!,
  );
  assert.equal(result.status, 200);

  const receiptRows = await db
    .select()
    .from(usageIngestReceipts)
    .where(eq(usageIngestReceipts.requestId, gatewayRequestId))
    .limit(1);
  assert.equal(receiptRows.length, 1, "usage still ingested without modelId");
});

run("generate-live-payment succeeds when live oracle fetch fails", async (t) => {
  resetEthUsdOracleCacheForTests();
  const restoreSigner = await ensureRunningSigner();
  t.after(restoreSigner);

  const app = await seedDeveloperAppWithClient({ status: "approved" });
  t.after(() => cleanupTestApp(app));

  const token = await createJobTokenForApp({
    userId: app.userId,
    clientId: app.clientId,
    scopes: "sign:job",
  });
  const auth = await validateBearerToken(token);
  assert.ok(auth);

  const orch = await buildOrchestratorInfoBase64({
    pricePerUnit: PRICE_PER_UNIT,
    pixelsPerUnit: PIXELS_PER_UNIT,
  });

  const mock = mockSignerFetch({
    signerHost: "https://test-signer.invalid",
  });
  t.after(mock.restore);

  const originalEthUsd = process.env.ETH_USD_PRICE;
  const originalFetch = globalThis.fetch;
  process.env.ETH_USD_PRICE = "2777.77";
  globalThis.fetch = async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url.includes("binance") || url.includes("kraken")) {
      return { ok: false, status: 503, json: async () => ({}) } as Response;
    }
    return originalFetch(input as never, init);
  };
  t.after(() => {
    process.env.ETH_USD_PRICE = originalEthUsd;
    globalThis.fetch = originalFetch;
  });

  const requestId = `oracle-fallback-${randomUUID()}`;
  const result = await proxyGenerateLivePayment(
    {
      ManifestID: "oracle-fallback-manifest",
      RequestID: requestId,
      InPixels: PER_REQUEST_PIXELS,
      Orchestrator: orch,
      pipeline: PIPELINE,
      modelId: MODEL_ID,
      gatewayRequestId: requestId,
    },
    auth!,
  );
  assert.equal(result.status, 200);

  const receiptRows = await db
    .select()
    .from(usageIngestReceipts)
    .where(eq(usageIngestReceipts.requestId, requestId))
    .limit(1);
  assert.equal(receiptRows.length, 1, "usage ingest receipt persisted with env ETH fallback");
});
