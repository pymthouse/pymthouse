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
  queryOpenMeterAppDashboardUsage,
} from "@/lib/openmeter/usage-read";
import {
  resolveViewerUsageClientIds,
  viewerHasAppUserMembership,
} from "@/lib/viewer-usage-clients";

test("queryOpenMeterAppDashboardUsage subject filter excludes other tenants", async () => {
  const clientId = `app_${randomUUID().replaceAll("-", "").slice(0, 24)}`;
  __testSetOpenMeterDashboardUsage(clientId, {
    byUser: [
      {
        externalUserId: "viewer-1",
        requestCount: 3,
        networkFeeUsdMicros: "3000",
      },
      {
        externalUserId: "other-explorer",
        requestCount: 9,
        networkFeeUsdMicros: "9000",
      },
    ],
    byPipelineModel: [
      {
        pipeline: "llm",
        modelId: "gpt",
        requestCount: 12,
        networkFeeUsdMicros: "12000",
      },
    ],
    byUserPipelineModel: [
      {
        externalUserId: "viewer-1",
        pipeline: "llm",
        modelId: "gpt",
        requestCount: 3,
        networkFeeUsdMicros: "3000",
      },
      {
        externalUserId: "other-explorer",
        pipeline: "llm",
        modelId: "gpt",
        requestCount: 9,
        networkFeeUsdMicros: "9000",
      },
    ],
    byDailyPipeline: [
      {
        pipeline: "llm",
        modelId: "gpt",
        date: "2026-07-01",
        requestCount: 12,
        networkFeeUsdMicros: "12000",
      },
    ],
    requestsByDay: new Map([["2026-07-01", 12]]),
  });

  try {
    const scoped = await queryOpenMeterAppDashboardUsage({
      clientId,
      externalUserId: "viewer-1",
    });
    assert.ok(scoped);
    assert.equal(scoped.byUser.length, 1);
    assert.equal(scoped.byUser[0]?.externalUserId, "viewer-1");
    assert.equal(scoped.byUser[0]?.requestCount, 3);
    assert.equal(scoped.byUserPipelineModel.length, 1);
    assert.equal(scoped.byPipelineModel[0]?.requestCount, 3);
    assert.equal(scoped.byPipelineModel[0]?.networkFeeUsdMicros, "3000");
    assert.equal(scoped.byDailyPipeline.length, 0);
    assert.equal(scoped.requestsByDay.size, 0);

    const unscoped = await queryOpenMeterAppDashboardUsage({ clientId });
    assert.ok(unscoped);
    assert.equal(unscoped.byUser.length, 2);
  } finally {
    __testClearOpenMeterUsageStubs();
  }
});

test("resolveViewerUsageClientIds includes owned apps and default membership", async (t) => {
  const ownerApp = await seedDeveloperAppWithClient({
    name: `Owned ${randomUUID().slice(0, 8)}`,
  });
  t.after(async () => {
    await cleanupTestApp(ownerApp);
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
      externalUserId: ownerApp.userId,
      status: "active",
      role: "user",
      createdAt: new Date().toISOString(),
    });

    const ids = await resolveViewerUsageClientIds(ownerApp.userId);
    assert.equal(ids.includes(ownerApp.clientId), true);
    assert.equal(ids.includes(defaultApp.clientId), true);
    assert.equal(
      await viewerHasAppUserMembership(ownerApp.userId, defaultApp.clientId),
      true,
    );
  });
});

test("resolveViewerUsageClientIds excludes foreign apps without membership", async (t) => {
  const viewerId = await createTestUser({ role: "developer" });
  t.after(async () => {
    await db.delete(users).where(eq(users.id, viewerId));
  });

  const foreign = await seedDeveloperAppWithClient({
    name: `Foreign ${randomUUID().slice(0, 8)}`,
  });
  t.after(async () => {
    await cleanupTestApp(foreign);
  });

  const ids = await resolveViewerUsageClientIds(viewerId);
  assert.equal(ids.includes(foreign.clientId), false);
});

test("resolveViewerUsageClientIds stays restrictive with only an owned app", async (t) => {
  const owned = await seedDeveloperAppWithClient({
    name: `Owned ${randomUUID().slice(0, 8)}`,
  });
  t.after(async () => {
    await cleanupTestApp(owned);
  });

  const foreign = await seedDeveloperAppWithClient({
    name: `Foreign ${randomUUID().slice(0, 8)}`,
  });
  t.after(async () => {
    await cleanupTestApp(foreign);
  });

  const ids = await resolveViewerUsageClientIds(owned.userId);
  assert.equal(ids.includes(owned.clientId), true);
  assert.equal(ids.includes(foreign.clientId), false);
});
