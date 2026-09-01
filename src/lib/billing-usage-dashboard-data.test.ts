import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";

import { test } from "@/test-utils/db-guard";
import {
  cleanupTestApp,
  createTestUser,
  seedDeveloperAppWithClient,
} from "@/test-utils/fixtures";
import { withTemporaryPlatformDefault } from "@/test-utils/platform-default-lock";
import { db } from "@/db/index";
import { appUsers, users } from "@/db/schema";
import {
  __testClearOpenMeterUsageStubs,
  __testSetOpenMeterDashboardUsage,
} from "@/lib/openmeter/usage-read";
import { getBillingUsageDashboardDataForUser } from "@/lib/billing-usage-dashboard-data";

import { PLATFORM_DEFAULT_USAGE_DISPLAY_NAME } from "@/lib/platform-default-labels";

test("My Usage includes subject-scoped Livepeer Direct for default-app members", async (t) => {
  const owned = await seedDeveloperAppWithClient({
    name: `Owned ${randomUUID().slice(0, 8)}`,
  });
  t.after(async () => {
    await cleanupTestApp(owned);
  });

  const defaultApp = await seedDeveloperAppWithClient({
    name: `Default ${randomUUID().slice(0, 8)}`,
  });
  t.after(async () => {
    await cleanupTestApp(defaultApp);
  });

  await withTemporaryPlatformDefault(defaultApp.clientId, async () => {
    await db.insert(appUsers).values({
      id: randomUUID(),
      clientId: defaultApp.clientId,
      externalUserId: owned.userId,
      status: "active",
      role: "user",
      createdAt: new Date().toISOString(),
    });

    __testSetOpenMeterDashboardUsage(owned.clientId, {
      byUser: [
        {
          externalUserId: "tenant-user",
          requestCount: 5,
          networkFeeUsdMicros: "5000",
        },
      ],
      byPipelineModel: [
        {
          pipeline: "llm",
          modelId: "a",
          requestCount: 5,
          networkFeeUsdMicros: "5000",
        },
      ],
      byUserPipelineModel: [
        {
          externalUserId: "tenant-user",
          pipeline: "llm",
          modelId: "a",
          requestCount: 5,
          networkFeeUsdMicros: "5000",
        },
      ],
      byDailyPipeline: [],
      requestsByDay: new Map([["2026-07-01", 5]]),
    });
    __testSetOpenMeterDashboardUsage(defaultApp.clientId, {
      byUser: [
        {
          externalUserId: owned.userId,
          requestCount: 2,
          networkFeeUsdMicros: "2000",
        },
        {
          externalUserId: "other-explorer",
          requestCount: 50,
          networkFeeUsdMicros: "50000",
        },
      ],
      byPipelineModel: [
        {
          pipeline: "llm",
          modelId: "b",
          requestCount: 52,
          networkFeeUsdMicros: "52000",
        },
      ],
      byUserPipelineModel: [
        {
          externalUserId: owned.userId,
          pipeline: "llm",
          modelId: "b",
          requestCount: 2,
          networkFeeUsdMicros: "2000",
        },
        {
          externalUserId: "other-explorer",
          pipeline: "llm",
          modelId: "b",
          requestCount: 50,
          networkFeeUsdMicros: "50000",
        },
      ],
      byDailyPipeline: [],
      requestsByDay: new Map([["2026-07-01", 52]]),
    });
    t.after(() => __testClearOpenMeterUsageStubs());

    const result = await getBillingUsageDashboardDataForUser(
      owned.userId,
      "developer",
      undefined,
      { ownAppsOnly: true },
    );

    assert.equal(result.ok, true);
    if (!result.ok) return;

    const personal = result.data.orderedApps.find(
      (app) => app.usageKind === "personal",
    );
    assert.ok(personal);
    assert.equal(personal.name, PLATFORM_DEFAULT_USAGE_DISPLAY_NAME);
    assert.equal(personal.publicClientId, defaultApp.clientId);

    // Default must not also appear as a full tenant source in My Usage.
    assert.equal(
      result.data.orderedApps.some(
        (app) =>
          app.usageKind === "tenant" && app.publicClientId === defaultApp.clientId,
      ),
      false,
    );

    assert.equal(result.data.totalRequests, 7);
    assert.equal(result.data.totalNetworkFeeUsdMicros.toString(), "7000");

    const personalUsage = result.data.appUsage.find(
      (row) => row.app.usageKind === "personal",
    );
    assert.ok(personalUsage);
    assert.equal(personalUsage.requestCount, 2);
    assert.equal(personalUsage.byUser.length, 1);
    assert.equal(personalUsage.byUser[0]?.externalUserId, owned.userId);
  });
});

test("Explorer with only default membership sees Livepeer Direct alone", async (t) => {
  const explorerId = await createTestUser({ role: "developer" });
  t.after(async () => {
    await db.delete(users).where(eq(users.id, explorerId));
  });

  const defaultApp = await seedDeveloperAppWithClient({
    name: `Default ${randomUUID().slice(0, 8)}`,
  });
  t.after(async () => {
    await cleanupTestApp(defaultApp);
  });

  await withTemporaryPlatformDefault(defaultApp.clientId, async () => {
    await db.insert(appUsers).values({
      id: randomUUID(),
      clientId: defaultApp.clientId,
      externalUserId: explorerId,
      status: "active",
      role: "user",
      createdAt: new Date().toISOString(),
    });

    __testSetOpenMeterDashboardUsage(defaultApp.clientId, {
      byUser: [
        {
          externalUserId: explorerId,
          requestCount: 3,
          networkFeeUsdMicros: "3000",
        },
        {
          externalUserId: "other-explorer",
          requestCount: 40,
          networkFeeUsdMicros: "40000",
        },
      ],
      byPipelineModel: [],
      byUserPipelineModel: [
        {
          externalUserId: explorerId,
          pipeline: "llm",
          modelId: "x",
          requestCount: 3,
          networkFeeUsdMicros: "3000",
        },
        {
          externalUserId: "other-explorer",
          pipeline: "llm",
          modelId: "x",
          requestCount: 40,
          networkFeeUsdMicros: "40000",
        },
      ],
      byDailyPipeline: [],
      requestsByDay: new Map(),
    });
    t.after(() => __testClearOpenMeterUsageStubs());

    const result = await getBillingUsageDashboardDataForUser(
      explorerId,
      "developer",
      undefined,
      { ownAppsOnly: true },
    );

    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.data.orderedApps.length, 1);
    assert.equal(result.data.orderedApps[0]?.usageKind, "personal");
    assert.equal(result.data.totalRequests, 3);
    assert.equal(result.data.totalNetworkFeeUsdMicros.toString(), "3000");
  });
});

test("admin My Usage subject-scopes default app they own", async (t) => {
  const adminId = await createTestUser({ role: "admin" });

  const defaultApp = await seedDeveloperAppWithClient({
    ownerId: adminId,
    name: `Default ${randomUUID().slice(0, 8)}`,
  });
  t.after(async () => {
    await cleanupTestApp(defaultApp);
    // cleanupTestApp deletes the owner; keep an explicit delete for any leftover.
    await db.delete(users).where(eq(users.id, adminId));
  });

  await withTemporaryPlatformDefault(defaultApp.clientId, async () => {
    await db.insert(appUsers).values({
      id: randomUUID(),
      clientId: defaultApp.clientId,
      externalUserId: adminId,
      status: "active",
      role: "user",
      createdAt: new Date().toISOString(),
    });

    __testSetOpenMeterDashboardUsage(defaultApp.clientId, {
      byUser: [
        {
          externalUserId: adminId,
          requestCount: 1,
          networkFeeUsdMicros: "1000",
        },
        {
          externalUserId: "other-explorer",
          requestCount: 99,
          networkFeeUsdMicros: "99000",
        },
      ],
      byPipelineModel: [],
      byUserPipelineModel: [
        {
          externalUserId: adminId,
          pipeline: "llm",
          modelId: "y",
          requestCount: 1,
          networkFeeUsdMicros: "1000",
        },
        {
          externalUserId: "other-explorer",
          pipeline: "llm",
          modelId: "y",
          requestCount: 99,
          networkFeeUsdMicros: "99000",
        },
      ],
      byDailyPipeline: [],
      requestsByDay: new Map(),
    });
    t.after(() => __testClearOpenMeterUsageStubs());

    const myUsage = await getBillingUsageDashboardDataForUser(
      adminId,
      "admin",
      undefined,
      { ownAppsOnly: true },
    );
    assert.equal(myUsage.ok, true);
    if (!myUsage.ok) return;

    const personal = myUsage.data.orderedApps.find(
      (app) => app.usageKind === "personal",
    );
    assert.ok(personal);
    assert.equal(
      myUsage.data.orderedApps.some(
        (app) =>
          app.usageKind === "tenant" && app.publicClientId === defaultApp.clientId,
      ),
      false,
    );
    assert.equal(myUsage.data.totalRequests, 1);
  });
});

test("admin All Usage keeps full tenant aggregate on platform default", async (t) => {
  const adminId = await createTestUser({ role: "admin" });

  const defaultApp = await seedDeveloperAppWithClient({
    ownerId: adminId,
    name: `Default ${randomUUID().slice(0, 8)}`,
  });
  t.after(async () => {
    await cleanupTestApp(defaultApp);
    await db.delete(users).where(eq(users.id, adminId));
  });

  await withTemporaryPlatformDefault(defaultApp.clientId, async () => {
    __testSetOpenMeterDashboardUsage(defaultApp.clientId, {
      byUser: [
        {
          externalUserId: "explorer-a",
          requestCount: 4,
          networkFeeUsdMicros: "4000",
        },
        {
          externalUserId: "explorer-b",
          requestCount: 6,
          networkFeeUsdMicros: "6000",
        },
      ],
      byPipelineModel: [],
      byUserPipelineModel: [],
      byDailyPipeline: [],
      requestsByDay: new Map(),
    });
    t.after(() => __testClearOpenMeterUsageStubs());

    const allUsage = await getBillingUsageDashboardDataForUser(
      adminId,
      "admin",
      undefined,
      { ownAppsOnly: false },
    );
    assert.equal(allUsage.ok, true);
    if (!allUsage.ok) return;

    const defaultRow = allUsage.data.orderedApps.find(
      (app) => app.publicClientId === defaultApp.clientId,
    );
    assert.ok(defaultRow);
    assert.equal(defaultRow.usageKind, "tenant");

    const usage = allUsage.data.appUsage.find(
      (row) => row.app.publicClientId === defaultApp.clientId,
    );
    assert.ok(usage);
    assert.equal(usage.requestCount, 10);
    assert.equal(usage.byUser.length, 2);
  });
});

test("usage dashboard reads the requested UTC billing month", async (t) => {
  const owned = await seedDeveloperAppWithClient({
    name: `Cycle ${randomUUID().slice(0, 8)}`,
  });
  t.after(async () => {
    await cleanupTestApp(owned);
  });

  __testSetOpenMeterDashboardUsage(owned.clientId, {
    byUser: [],
    byPipelineModel: [],
    byUserPipelineModel: [],
    byDailyPipeline: [],
    requestsByDay: new Map(),
  });
  t.after(() => __testClearOpenMeterUsageStubs());

  const result = await getBillingUsageDashboardDataForUser(
    owned.userId,
    "developer",
    undefined,
    { ownAppsOnly: true, cycleKey: "2026-01" },
  );
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.data.cycle.start, "2026-01-01T00:00:00.000Z");
  assert.equal(result.data.cycle.end, "2026-01-31T23:59:59.999Z");
});
