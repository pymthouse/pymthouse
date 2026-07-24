import assert from "node:assert/strict";

import { test } from "@/test-utils/db-guard";
import {
  basicAuthHeader,
  cleanupTestApp,
  seedDeveloperAppWithClient,
} from "@/test-utils/fixtures";
import {
  __testClearOpenMeterUsageStubs,
  __testSetOpenMeterDailyPipelineRows,
  __testSetOpenMeterDashboardUsage,
  __testSetOpenMeterUsageRows,
} from "@/lib/openmeter/usage-read";

test("usage API requires a matching client or authorized session", async (t) => {
  const { GET } = await import("./route");
  const app = await seedDeveloperAppWithClient({ status: "approved" });
  t.after(() => cleanupTestApp(app));

  const anonymous = await GET(
    new Request(`http://localhost/api/v1/apps/${app.clientId}/usage`),
    { params: Promise.resolve({ id: app.clientId }) },
  );
  assert.equal(anonymous.status, 404);

  const wrong = await GET(
    new Request(`http://localhost/api/v1/apps/${app.clientId}/usage`, {
      headers: { Authorization: basicAuthHeader(app.clientId, "pmth_cs_nope") },
    }),
    { params: Promise.resolve({ id: app.clientId }) },
  );
  assert.equal(wrong.status, 404);

  const other = await seedDeveloperAppWithClient({ status: "approved" });
  t.after(() => cleanupTestApp(other));
  const crossTenant = await GET(
    new Request(`http://localhost/api/v1/apps/${other.clientId}/usage`, {
      headers: { Authorization: basicAuthHeader(app.clientId, app.clientSecret) },
    }),
    { params: Promise.resolve({ id: other.clientId }) },
  );
  assert.equal(crossTenant.status, 404);

  __testSetOpenMeterUsageRows(app.clientId, [
    {
      externalUserId: "alpha-ext",
      requestCount: 1,
      networkFeeUsdMicros: "1000",
    },
  ]);
  t.after(() => __testClearOpenMeterUsageStubs());

  const ok = await GET(
    new Request(`http://localhost/api/v1/apps/${app.clientId}/usage`, {
      headers: { Authorization: basicAuthHeader(app.clientId, app.clientSecret) },
    }),
    { params: Promise.resolve({ id: app.clientId }) },
  );
  assert.equal(ok.status, 200);
});

test("usage API aggregates OpenMeter meter rows and validates input", async (t) => {
  const { GET } = await import("./route");

  const app = await seedDeveloperAppWithClient({ status: "approved" });
  t.after(() => cleanupTestApp(app));

  __testSetOpenMeterUsageRows(app.clientId, [
    {
      externalUserId: "alpha-ext",
      requestCount: 2,
      networkFeeUsdMicros: "3000000",
    },
    {
      externalUserId: "beta-ext",
      requestCount: 1,
      networkFeeUsdMicros: "500000",
    },
    {
      externalUserId: "unknown",
      requestCount: 1,
      networkFeeUsdMicros: "10",
    },
  ]);
  t.after(() => __testClearOpenMeterUsageStubs());

  async function call(query = "") {
    const res = await GET(
      new Request(`http://localhost/api/v1/apps/${app.clientId}/usage${query}`, {
        headers: { Authorization: basicAuthHeader(app.clientId, app.clientSecret) },
      }),
      { params: Promise.resolve({ id: app.clientId }) },
    );
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  }

  const all = await call();
  assert.equal(all.status, 200);
  assert.equal((all.body as { source: string }).source, "openmeter");
  const allTotals = (all.body as {
    totals: { requestCount: number; networkFeeUsdMicros: string };
  }).totals;
  assert.equal(allTotals.requestCount, 4);
  assert.equal(allTotals.networkFeeUsdMicros, "3500010");

  const betaOnly = await call(`?userId=${encodeURIComponent("beta-ext")}`);
  assert.equal(betaOnly.status, 200);
  const betaTotals = (betaOnly.body as {
    totals: { requestCount: number; networkFeeUsdMicros: string };
  }).totals;
  assert.equal(betaTotals.requestCount, 1);
  assert.equal(betaTotals.networkFeeUsdMicros, "500000");

  const grouped = await call("?groupBy=user");
  const buckets = (grouped.body as {
    byUser: {
      endUserId: string;
      externalUserId: string;
      requestCount: number;
    }[];
  }).byUser;
  assert.equal(buckets.length, 3);

  const badStart = await call("?startDate=not-a-date");
  assert.equal(badStart.status, 400);
});

test("usage API groupBy=pipeline_model reads OpenMeter dashboard meters", async (t) => {
  const { GET } = await import("./route");

  const app = await seedDeveloperAppWithClient({ status: "approved" });
  t.after(() => cleanupTestApp(app));

  __testSetOpenMeterUsageRows(app.clientId, [
    {
      externalUserId: "alpha-ext",
      requestCount: 3,
      networkFeeUsdMicros: "6000000",
    },
  ]);
  __testSetOpenMeterDashboardUsage(app.clientId, {
    byUser: [
      {
        externalUserId: "alpha-ext",
        requestCount: 3,
        networkFeeUsdMicros: "6000000",
      },
    ],
    byPipelineModel: [
      {
        pipeline: "text-to-image",
        modelId: "stabilityai/sdxl",
        requestCount: 2,
        networkFeeUsdMicros: "3000000",
      },
      {
        pipeline: "llm",
        modelId: "openai-chat-completions",
        requestCount: 1,
        networkFeeUsdMicros: "3000000",
      },
    ],
    byUserPipelineModel: [
      {
        externalUserId: "alpha-ext",
        pipeline: "text-to-image",
        modelId: "stabilityai/sdxl",
        requestCount: 2,
        networkFeeUsdMicros: "3000000",
      },
      {
        externalUserId: "alpha-ext",
        pipeline: "llm",
        modelId: "openai-chat-completions",
        requestCount: 1,
        networkFeeUsdMicros: "3000000",
      },
    ],
    byDailyPipeline: [
      {
        pipeline: "text-to-image",
        modelId: "stabilityai/sdxl",
        date: "2026-06-01",
        requestCount: 2,
        networkFeeUsdMicros: "0",
      },
      {
        pipeline: "llm",
        modelId: "openai-chat-completions",
        date: "2026-06-01",
        requestCount: 1,
        networkFeeUsdMicros: "0",
      },
    ],
    requestsByDay: new Map([["2026-06-01", 3]]),
  });
  t.after(() => __testClearOpenMeterUsageStubs());

  const res = await GET(
    new Request(
      `http://localhost/api/v1/apps/${app.clientId}/usage?groupBy=pipeline_model`,
      {
        headers: { Authorization: basicAuthHeader(app.clientId, app.clientSecret) },
      },
    ),
    { params: Promise.resolve({ id: app.clientId }) },
  );
  assert.equal(res.status, 200);
  const byPipelineModel = (await res.json()) as {
    byPipelineModel: Array<{
      pipeline: string;
      modelId: string;
      requestCount: number;
      networkFeeUsdMicros: string;
    }>;
  };
  assert.equal(byPipelineModel.byPipelineModel.length, 2);
});

test("usage API groupBy=daily_pipeline requires userId and returns day buckets", async (t) => {
  const { GET } = await import("./route");

  const app = await seedDeveloperAppWithClient({ status: "approved" });
  t.after(() => cleanupTestApp(app));

  __testSetOpenMeterDailyPipelineRows(app.clientId, [
    {
      pipeline: "live-video-to-video",
      modelId: "streamdiffusion",
      date: "2026-06-02",
      requestCount: 5,
      networkFeeUsdMicros: "50000",
    },
    {
      pipeline: "live-video-to-video",
      modelId: "streamdiffusion",
      date: "2026-06-03",
      requestCount: 14,
      networkFeeUsdMicros: "63277",
    },
  ]);
  t.after(() => __testClearOpenMeterUsageStubs());

  const missingUser = await GET(
    new Request(
      `http://localhost/api/v1/apps/${app.clientId}/usage?groupBy=daily_pipeline`,
      {
        headers: { Authorization: basicAuthHeader(app.clientId, app.clientSecret) },
      },
    ),
    { params: Promise.resolve({ id: app.clientId }) },
  );
  assert.equal(missingUser.status, 400);

  const res = await GET(
    new Request(
      `http://localhost/api/v1/apps/${app.clientId}/usage?groupBy=daily_pipeline&userId=${encodeURIComponent("john@example.com")}`,
      {
        headers: { Authorization: basicAuthHeader(app.clientId, app.clientSecret) },
      },
    ),
    { params: Promise.resolve({ id: app.clientId }) },
  );
  assert.equal(res.status, 200);
  const body = (await res.json()) as {
    byDailyPipeline: Array<{ date: string; requestCount: number }>;
  };
  assert.equal(body.byDailyPipeline.length, 2);
  assert.equal(
    body.byDailyPipeline.reduce((sum, row) => sum + row.requestCount, 0),
    19,
  );
});
