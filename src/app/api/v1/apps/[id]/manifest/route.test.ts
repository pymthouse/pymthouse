import assert from "node:assert/strict";
import test from "node:test";

import { eq } from "drizzle-orm";
import { db } from "@/db/index";
import { planCapabilityBundles, plans } from "@/db/schema";
import { computeManifestRevision } from "@/lib/discovery-allowlist";
import { run } from "@/test-utils/db-guard";
import { cleanupTestApp, seedDeveloperAppWithClient } from "@/test-utils/fixtures";
import {
  installNaapCatalogMock,
  uninstallNaapCatalogMock,
} from "@/test-utils/naap-catalog-mock";
import {
  installProviderAppSessionAuth,
  uninstallProviderAppSessionAuth,
} from "@/test-utils/provider-app-session-auth";
import { selectNetworkDefaultPlan } from "@/lib/network-default-plan";

let authorizedApp: { clientId: string; userId: string } | null = null;

installProviderAppSessionAuth(() => authorizedApp);

let catalogThrows = false;
let catalogFetchCount = 0;

const MOCK_CATALOG = [
  { id: "pipe-a", name: "Pipe A", models: ["m1", "m2"] },
  { id: "pipe-b", name: "Pipe B", models: ["only"] },
];

installNaapCatalogMock({
  catalog: MOCK_CATALOG,
  onFetch: () => {
    catalogFetchCount += 1;
  },
  shouldThrow: () => catalogThrows,
});

test.after(() => {
  uninstallNaapCatalogMock();
  uninstallProviderAppSessionAuth();
});

run("manifest GET and PUT", async (t) => {
  await t.test("GET returns full catalog and manifestVersion when exclusions empty", async (t) => {
    catalogFetchCount = 0;
    catalogThrows = false;
    const app = await seedDeveloperAppWithClient({ status: "approved" });
    authorizedApp = app;
    t.after(async () => {
      authorizedApp = null;
      await cleanupTestApp(app);
    });

    const { GET } = await import("./route");
    const res = await GET(
      new Request(`http://localhost/api/v1/apps/${app.clientId}/manifest`) as never,
      { params: Promise.resolve({ id: app.clientId }) },
    );
    assert.equal(res.status, 200);
    assert.equal(catalogFetchCount, 1);
    const body = (await res.json()) as {
      capabilities: unknown[];
      excludedCapabilities: unknown[];
      manifestVersion: string;
    };
    assert.deepEqual(body.capabilities, [
      { pipeline: "pipe-a", modelId: "m1" },
      { pipeline: "pipe-a", modelId: "m2" },
      { pipeline: "pipe-b", modelId: "only" },
    ]);
    assert.deepEqual(body.excludedCapabilities, []);
    assert.equal(
      body.manifestVersion,
      computeManifestRevision({
        capabilities: body.capabilities as { pipeline: string; modelId: string }[],
        excludedCapabilities: [],
      }),
    );
  });

  await t.test("GET resolves exclusions against catalog on Network Price plan", async (t) => {
    catalogFetchCount = 0;
    catalogThrows = false;
    const app = await seedDeveloperAppWithClient({ status: "approved" });
    authorizedApp = app;
    t.after(async () => {
      authorizedApp = null;
      await cleanupTestApp(app);
    });

    const def = await selectNetworkDefaultPlan(app.clientId, db);
    assert.ok(def);
    await db
      .update(plans)
      .set({
        discoveryExcludedCapabilities: {
          capabilities: [{ pipeline: "pipe-a", modelId: "m1" }],
        },
      })
      .where(eq(plans.id, def!.id));

    const { GET } = await import("./route");
    const res = await GET(
      new Request(`http://localhost/api/v1/apps/${app.clientId}/manifest`) as never,
      { params: Promise.resolve({ id: app.clientId }) },
    );
    assert.equal(res.status, 200);
    assert.ok(catalogFetchCount >= 1);
    const body = (await res.json()) as {
      capabilities: Array<{ pipeline: string; modelId: string }>;
      excludedCapabilities: Array<{ pipeline: string; modelId: string }>;
      manifestVersion: string;
    };
    assert.deepEqual(body.excludedCapabilities, [
      { pipeline: "pipe-a", modelId: "m1" },
    ]);
    assert.deepEqual(body.capabilities, [
      { pipeline: "pipe-a", modelId: "m2" },
      { pipeline: "pipe-b", modelId: "only" },
    ]);
    assert.ok(body.manifestVersion.length >= 5);
  });

  await t.test("GET applies pipeline wildcard exclusion", async (t) => {
    catalogThrows = false;
    const app = await seedDeveloperAppWithClient({ status: "approved" });
    authorizedApp = app;
    t.after(async () => {
      authorizedApp = null;
      await cleanupTestApp(app);
    });

    const def = await selectNetworkDefaultPlan(app.clientId, db);
    await db
      .update(plans)
      .set({
        discoveryExcludedCapabilities: {
          capabilities: [{ pipeline: "pipe-a", modelId: "*" }],
        },
      })
      .where(eq(plans.id, def!.id));

    const { GET } = await import("./route");
    const res = await GET(
      new Request(`http://localhost/api/v1/apps/${app.clientId}/manifest`) as never,
      { params: Promise.resolve({ id: app.clientId }) },
    );
    assert.equal(res.status, 200);
    const body = (await res.json()) as {
      capabilities: Array<{ pipeline: string; modelId: string }>;
    };
    assert.deepEqual(body.capabilities, [{ pipeline: "pipe-b", modelId: "only" }]);
  });

  await t.test("GET returns degraded manifest when catalog fetch throws", async (t) => {
    catalogThrows = true;
    const app = await seedDeveloperAppWithClient({ status: "approved" });
    authorizedApp = app;
    t.after(async () => {
      catalogThrows = false;
      authorizedApp = null;
      await cleanupTestApp(app);
    });

    const def = await selectNetworkDefaultPlan(app.clientId, db);
    await db
      .update(plans)
      .set({
        discoveryExcludedCapabilities: {
          capabilities: [{ pipeline: "pipe-a", modelId: "m1" }],
        },
      })
      .where(eq(plans.id, def!.id));

    const { GET } = await import("./route");
    const res = await GET(
      new Request(`http://localhost/api/v1/apps/${app.clientId}/manifest`) as never,
      { params: Promise.resolve({ id: app.clientId }) },
    );
    assert.equal(res.status, 200);
    const body = (await res.json()) as {
      capabilities: unknown[];
      excludedCapabilities: Array<{ pipeline: string; modelId: string }>;
      manifestVersion: string;
    };
    assert.deepEqual(body.capabilities, []);
    assert.deepEqual(body.excludedCapabilities, [
      { pipeline: "pipe-a", modelId: "m1" },
    ]);
    assert.ok(body.manifestVersion);
  });

  await t.test("PUT persists exclusions on network default plan row", async (t) => {
    catalogThrows = false;
    const app = await seedDeveloperAppWithClient({ status: "approved" });
    authorizedApp = app;
    t.after(async () => {
      authorizedApp = null;
      await cleanupTestApp(app);
    });

    const { PUT } = await import("./route");
    const putRes = await PUT(
      new Request(`http://localhost/api/v1/apps/${app.clientId}/manifest`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          excludedCapabilities: [{ pipeline: "pipe-b", modelId: "only" }],
        }),
      }) as never,
      { params: Promise.resolve({ id: app.clientId }) },
    );
    assert.equal(putRes.status, 200);
    const putBody = (await putRes.json()) as {
      capabilities: Array<{ pipeline: string; modelId: string }>;
      excludedCapabilities: Array<{ pipeline: string; modelId: string }>;
      manifestVersion: string;
    };
    assert.deepEqual(putBody.excludedCapabilities, [
      { pipeline: "pipe-b", modelId: "only" },
    ]);
    assert.deepEqual(putBody.capabilities, [
      { pipeline: "pipe-a", modelId: "m1" },
      { pipeline: "pipe-a", modelId: "m2" },
    ]);
    assert.ok(putBody.manifestVersion);

    const def = await selectNetworkDefaultPlan(app.clientId, db);
    assert.deepEqual(def?.discoveryExcludedCapabilities, {
      capabilities: [{ pipeline: "pipe-b", modelId: "only" }],
    });
  });

  await t.test("PUT returns 409 when exclusions would orphan a custom plan bundle", async (t) => {
    catalogThrows = false;
    const app = await seedDeveloperAppWithClient({ status: "approved" });
    authorizedApp = app;
    t.after(async () => {
      authorizedApp = null;
      await cleanupTestApp(app);
    });

    const bundleId = "test-bundle-conflict-1";
    const { v4: uuidv4 } = await import("uuid");
    const customPlanId = uuidv4();
    const now = new Date().toISOString();
    await db.insert(plans).values({
      id: customPlanId,
      clientId: app.clientId,
      name: "Enterprise",
      type: "free",
      priceAmount: "0",
      priceCurrency: "USD",
      status: "active",
      billingCycle: "monthly",
      isNetworkDefault: false,
      discoveryExcludedCapabilities: null,
      createdAt: now,
      updatedAt: now,
    });
    await db.insert(planCapabilityBundles).values({
      id: bundleId,
      planId: customPlanId,
      clientId: app.clientId,
      pipeline: "pipe-b",
      modelId: "only",
      slaTargetP95Ms: null,
      maxPricePerUnit: null,
      upchargePercentBps: 100,
      createdAt: now,
    });

    const { PUT } = await import("./route");
    const putRes = await PUT(
      new Request(`http://localhost/api/v1/apps/${app.clientId}/manifest`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          excludedCapabilities: [{ pipeline: "pipe-b", modelId: "only" }],
        }),
      }) as never,
      { params: Promise.resolve({ id: app.clientId }) },
    );
    assert.equal(putRes.status, 409);
  });
});
