import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import Module from "node:module";
import test from "node:test";

import { and, eq } from "drizzle-orm";
import { db } from "@/db/index";
import { discoveryProfiles, plans } from "@/db/schema";
import { run } from "@/test-utils/db-guard";
import {
  cleanupTestApp,
  seedDeveloperAppWithClient,
  type SeededDeveloperApp,
} from "@/test-utils/fixtures";

let authorizedApp: SeededDeveloperApp | null = null;

type ModuleLoad = (
  request: string,
  parent: NodeJS.Module | null | undefined,
  isMain: boolean,
) => unknown;

const moduleWithLoad = Module as unknown as { _load: ModuleLoad };
const originalLoad = moduleWithLoad._load;
moduleWithLoad._load = (request, parent, isMain) => {
  if (request === "next-auth") {
    return {
      getServerSession: async () =>
        authorizedApp
          ? {
              user: {
                id: authorizedApp.userId,
                role: "developer",
              },
            }
          : null,
    };
  }
  return originalLoad(request, parent, isMain);
};

test.after(() => {
  moduleWithLoad._load = originalLoad;
});

async function postPlan(clientId: string, body: Record<string, unknown>) {
  const { POST } = await import("./route");
  const res = await POST(
    new Request(`http://localhost/api/v1/apps/${clientId}/plans`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }) as never,
    { params: Promise.resolve({ id: clientId }) },
  );
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

run("plans API: network default plan rules", async (t) => {
  const prevLoad = moduleWithLoad._load;
  const MOCK_CATALOG = [
    { id: "pipe-a", name: "A", models: ["m1", "m2"] },
    { id: "pipe-b", name: "B", models: ["only"] },
  ];
  moduleWithLoad._load = (request, parent, isMain) => {
    if (typeof request === "string" && request.includes("naap-catalog")) {
      return {
        fetchPipelineCatalog: async () => MOCK_CATALOG,
      };
    }
    return prevLoad(request, parent, isMain);
  };
  t.after(() => {
    moduleWithLoad._load = prevLoad;
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
      new Request(`http://localhost/api/v1/apps/${app.clientId}/plans`) as never,
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
    assert.equal(r.body.error, "is_network_default cannot be set on created plans");
  });

  await t.test("POST rejects reserved Network Price display name", async (t) => {
    const app = await seedDeveloperAppWithClient({ status: "approved" });
    authorizedApp = app;
    t.after(async () => {
      authorizedApp = null;
      await cleanupTestApp(app);
    });

    const r = await postPlan(app.clientId, {
      name: "Network Price",
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
      }) as never,
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
      ) as never,
      { params: Promise.resolve({ id: app.clientId }) },
    );
    assert.equal(res.status, 409);
  });
});

run("plans POST validates subscription billing fields before creating a plan", async (t) => {
  const app = await seedDeveloperAppWithClient({ status: "approved" });
  authorizedApp = app;
  t.after(async () => {
    authorizedApp = null;
    await cleanupTestApp(app);
  });

  const missingBilling = await postPlan(app.clientId, {
    name: "Subscription without quota",
    type: "subscription",
    priceAmount: "20",
    priceCurrency: "USD",
  });
  assert.equal(missingBilling.status, 400);
  assert.equal(
    missingBilling.body.error,
    "includedUnits and overageRateWei are required for subscription plans",
  );

  const valid = await postPlan(app.clientId, {
    name: "Subscription with quota",
    type: "subscription",
    priceAmount: "20",
    priceCurrency: "USD",
    includedUnits: "1000000",
    overageRateWei: "25",
    includedUsdMicros: "20000000",
    generalUpchargePercentBps: 2000,
  });
  assert.equal(valid.status, 201);
  assert.equal(typeof valid.body.id, "string");

  const planRows = await db
    .select()
    .from(plans)
    .where(eq(plans.id, valid.body.id as string))
    .limit(1);
  assert.equal(planRows.length, 1);
  assert.equal(planRows[0].clientId, app.clientId);
  assert.equal(planRows[0].type, "subscription");
  assert.equal(planRows[0].includedUnits?.toString(), "1000000");
  assert.equal(planRows[0].overageRateWei?.toString(), "25");
  assert.equal(planRows[0].includedUsdMicros, "20000000");
  assert.equal(planRows[0].generalUpchargePercentBps, 2000);
});

run("plans POST validates capabilities and discovery policy payloads", async (t) => {
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
