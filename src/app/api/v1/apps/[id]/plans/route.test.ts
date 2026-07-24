import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import { and, eq } from "drizzle-orm";
import { db } from "@/db/index";
import { discoveryProfiles, plans } from "@/db/schema";
import { test } from "@/test-utils/db-guard";
import {
  cleanupTestApp,
  seedDeveloperAppWithClient,
  type SeededDeveloperApp,
} from "@/test-utils/fixtures";
import {
  installNaapCatalogMock,
  uninstallNaapCatalogMock,
} from "@/test-utils/naap-catalog-mock";
import {
  installProviderAppSessionAuth,
  uninstallProviderAppSessionAuth,
} from "@/test-utils/provider-app-session-auth";

let authorizedApp: SeededDeveloperApp | null = null;

installProviderAppSessionAuth(() => authorizedApp);

test.after(() => {
  uninstallProviderAppSessionAuth();
});

async function postPlan(clientId: string, body: Record<string, unknown>) {
  const { POST } = await import("./route");
  const res = await POST(
    new Request(`http://localhost/api/v1/apps/${clientId}/plans`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ id: clientId }) },
  );
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

test("plans API: network default plan rules", async (t) => {
  const MOCK_CATALOG = [
    { id: "pipe-a", name: "A", models: ["m1", "m2"] },
    { id: "pipe-b", name: "B", models: ["only"] },
  ];
  installNaapCatalogMock({ catalog: MOCK_CATALOG });
  t.after(() => {
    uninstallNaapCatalogMock();
  });

  await t.test("GET lists exactly one network default plan", async (t) => {
    const app = await seedDeveloperAppWithClient({ status: "approved" });
    authorizedApp = app;
    t.after(async () => {
      authorizedApp = null;
      await cleanupTestApp(app);
    });

    const { GET } = await import("./route");
    const res = await GET(
      new Request(`http://localhost/api/v1/apps/${app.clientId}/plans`),
      { params: Promise.resolve({ id: app.clientId }) },
    );
    assert.equal(res.status, 200);
    const body = (await res.json()) as {
      plans: Array<{ isNetworkDefault?: boolean; discoveryExcludedCapabilities?: unknown }>;
    };
    const defaults = body.plans.filter((p) => p.isNetworkDefault);
    assert.equal(defaults.length, 1);
    assert.ok("discoveryExcludedCapabilities" in defaults[0]!);
  });

  await t.test("POST rejects is_network_default", async (t) => {
    const app = await seedDeveloperAppWithClient({ status: "approved" });
    authorizedApp = app;
    t.after(async () => {
      authorizedApp = null;
      await cleanupTestApp(app);
    });

    const r = await postPlan(app.clientId, {
      name: "Shadow default",
      type: "free",
      is_network_default: true,
    });
    assert.equal(r.status, 400);
    assert.ok(
      typeof r.body.error === "string" &&
        r.body.error.includes("is_network_default"),
    );
  });

  await t.test("GET lists exactly one starter default plan", async (t) => {
    const app = await seedDeveloperAppWithClient({ status: "approved" });
    authorizedApp = app;
    t.after(async () => {
      authorizedApp = null;
      await cleanupTestApp(app);
    });

    const { GET } = await import("./route");
    const res = await GET(
      new Request(`http://localhost/api/v1/apps/${app.clientId}/plans`),
      { params: Promise.resolve({ id: app.clientId }) },
    );
    assert.equal(res.status, 200);
    const body = (await res.json()) as {
      plans: Array<{ isStarterDefault?: boolean; includedUsdMicros?: string | null }>;
    };
    const starters = body.plans.filter((p) => p.isStarterDefault);
    assert.equal(starters.length, 1);
    const starter = starters[0];
    assert.ok(starter?.includedUsdMicros);
  });

  await t.test("DELETE starter default plan returns 409", async (t) => {
    const app = await seedDeveloperAppWithClient({ status: "approved" });
    authorizedApp = app;
    t.after(async () => {
      authorizedApp = null;
      await cleanupTestApp(app);
    });

    const starterRows = await db
      .select({ id: plans.id })
      .from(plans)
      .where(and(eq(plans.clientId, app.clientId), eq(plans.isStarterDefault, true)))
      .limit(1);

    const { DELETE } = await import("./route");
    const res = await DELETE(
      new Request(
        `http://localhost/api/v1/apps/${app.clientId}/plans?planId=${starterRows[0]!.id}`,
      ),
      { params: Promise.resolve({ id: app.clientId }) },
    );
    assert.equal(res.status, 409);
    const delBody = (await res.json()) as { error?: string };
    assert.ok(typeof delBody.error === "string" && delBody.error.includes("Starter"));
  });

  await t.test("POST rejects reserved Network Discovery display name", async (t) => {
    const app = await seedDeveloperAppWithClient({ status: "approved" });
    authorizedApp = app;
    t.after(async () => {
      authorizedApp = null;
      await cleanupTestApp(app);
    });

    const r = await postPlan(app.clientId, {
      name: "Network Discovery",
      type: "free",
    });
    assert.equal(r.status, 400);
    assert.ok(
      typeof r.body.error === "string" && r.body.error.includes("reserved"),
    );
  });

  await t.test("POST 400 when capability is excluded on Network Price plan", async (t) => {
    const app = await seedDeveloperAppWithClient({ status: "approved" });
    authorizedApp = app;
    t.after(async () => {
      authorizedApp = null;
      await cleanupTestApp(app);
    });

    const defRows = await db
      .select({ id: plans.id })
      .from(plans)
      .where(and(eq(plans.clientId, app.clientId), eq(plans.isNetworkDefault, true)))
      .limit(1);
    await db
      .update(plans)
      .set({
        discoveryExcludedCapabilities: {
          capabilities: [{ pipeline: "pipe-a", modelId: "m1" }],
        },
      })
      .where(eq(plans.id, defRows[0]!.id));

    const r = await postPlan(app.clientId, {
      name: "Enterprise",
      type: "free",
      capabilities: [{ pipeline: "pipe-a", modelId: "m1" }],
    });
    assert.equal(r.status, 400);
    assert.ok(Array.isArray((r.body as { conflicts?: unknown[] }).conflicts));
  });

  await t.test("PUT targeting network default plan returns 400", async (t) => {
    const app = await seedDeveloperAppWithClient({ status: "approved" });
    authorizedApp = app;
    t.after(async () => {
      authorizedApp = null;
      await cleanupTestApp(app);
    });

    const defRows = await db
      .select({ id: plans.id })
      .from(plans)
      .where(and(eq(plans.clientId, app.clientId), eq(plans.isNetworkDefault, true)))
      .limit(1);

    const { PUT } = await import("./route");
    const res = await PUT(
      new Request(`http://localhost/api/v1/apps/${app.clientId}/plans`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: defRows[0]!.id, name: "Renamed" }),
      }),
      { params: Promise.resolve({ id: app.clientId }) },
    );
    assert.equal(res.status, 400);
    const putBody = (await res.json()) as { error?: string };
    assert.ok(
      typeof putBody.error === "string" &&
        putBody.error.includes("Network Price default plan"),
    );
  });

  await t.test("DELETE network default plan returns 409", async (t) => {
    const app = await seedDeveloperAppWithClient({ status: "approved" });
    authorizedApp = app;
    t.after(async () => {
      authorizedApp = null;
      await cleanupTestApp(app);
    });

    const defRows = await db
      .select({ id: plans.id })
      .from(plans)
      .where(and(eq(plans.clientId, app.clientId), eq(plans.isNetworkDefault, true)))
      .limit(1);

    const { DELETE } = await import("./route");
    const res = await DELETE(
      new Request(
        `http://localhost/api/v1/apps/${app.clientId}/plans?planId=${defRows[0]!.id}`,
      ),
      { params: Promise.resolve({ id: app.clientId }) },
    );
    assert.equal(res.status, 409);
  });
});

test("plans POST accepts subscription with retail overageRateUsd", async (t) => {
  installNaapCatalogMock({
    catalog: [
      { id: "text-to-image", name: "Text to Image", models: ["stabilityai/sdxl"] },
    ],
  });
  t.after(() => {
    uninstallNaapCatalogMock();
  });

  const app = await seedDeveloperAppWithClient({ status: "approved" });
  authorizedApp = app;
  t.after(async () => {
    authorizedApp = null;
    await cleanupTestApp(app);
  });

  const valid = await postPlan(app.clientId, {
    name: "Subscription with retail",
    type: "subscription",
    priceAmount: "20",
    priceCurrency: "USD",
    overageRateUsd: "0.0000015",
    includedUsdMicros: "20000000",
    capabilities: [
      {
        pipeline: "text-to-image",
        modelId: "stabilityai/sdxl",
        retailRateUsd: "0.000002",
      },
    ],
  });
  assert.equal(valid.status, 201);
  assert.equal(typeof valid.body.id, "string");

  const planRows = await db
    .select()
    .from(plans)
    .where(eq(plans.id, valid.body.id as string))
    .limit(1);
  assert.equal(planRows.length, 1);
  assert.equal(planRows[0].type, "subscription");
  assert.equal(planRows[0].overageRateUsd, "0.0000015");
  assert.equal(planRows[0].includedUsdMicros, "20000000");
});

test("plans POST validates capabilities and discovery policy payloads", async (t) => {
  const app = await seedDeveloperAppWithClient({ status: "approved" });
  authorizedApp = app;
  t.after(async () => {
    authorizedApp = null;
    await cleanupTestApp(app);
  });

  const nonArrayCapabilities = await postPlan(app.clientId, {
    name: "Bad capabilities",
    type: "free",
    capabilities: { pipeline: "text-to-image", modelId: "*" },
  });
  assert.equal(nonArrayCapabilities.status, 400);
  assert.equal(nonArrayCapabilities.body.error, "capabilities must be an array");

  const missingPipeline = await postPlan(app.clientId, {
    name: "Missing capability pipeline",
    type: "free",
    capabilities: [{ modelId: "*" }],
  });
  assert.equal(missingPipeline.status, 400);
  assert.equal(missingPipeline.body.error, "capabilities[0].pipeline is required");

  const invalidProfile = await postPlan(app.clientId, {
    name: "Invalid profile ref",
    type: "free",
    discoveryProfileId: randomUUID(),
  });
  assert.equal(invalidProfile.status, 400);
  assert.equal(
    typeof invalidProfile.body.error === "string" &&
      invalidProfile.body.error.includes("discoveryProfileId"),
    true,
  );

  const profileId = randomUUID();
  const now = new Date().toISOString();
  await db.insert(discoveryProfiles).values({
    id: profileId,
    clientId: app.clientId,
    name: "For plan test",
    policy: { topN: 5 },
    createdAt: now,
    updatedAt: now,
  });

  const withProfile = await postPlan(app.clientId, {
    name: "Plan with profile",
    type: "free",
    discoveryProfileId: profileId,
  });
  assert.equal(withProfile.status, 201);
  const planRows = await db
    .select()
    .from(plans)
    .where(eq(plans.id, withProfile.body.id as string))
    .limit(1);
  assert.equal(planRows[0]?.discoveryProfileId, profileId);
});
