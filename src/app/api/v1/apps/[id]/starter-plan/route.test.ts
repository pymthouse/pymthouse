import assert from "node:assert/strict";
import { and, eq } from "drizzle-orm";

import { db } from "@/db/index";
import { plans } from "@/db/schema";
import { test } from "@/test-utils/db-guard";
import {
  cleanupTestApp,
  seedDeveloperAppWithClient,
  type SeededDeveloperApp,
} from "@/test-utils/fixtures";
import {
  installProviderAppSessionAuth,
  uninstallProviderAppSessionAuth,
} from "@/test-utils/provider-app-session-auth";

let authorizedApp: SeededDeveloperApp | null = null;

installProviderAppSessionAuth(() => authorizedApp);

test.after(() => {
  uninstallProviderAppSessionAuth();
});

async function putStarter(
  clientId: string,
  body: Record<string, unknown>,
) {
  const { PUT } = await import("./route");
  const res = await PUT(
    new Request(`http://localhost/api/v1/apps/${clientId}/starter-plan`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ id: clientId }) },
  );
  return {
    status: res.status,
    body: (await res.json()) as Record<string, unknown>,
  };
}

test("starter-plan API", async (t) => {
  await t.test("PUT updates includedUsdMicros", async (t) => {
    const app = await seedDeveloperAppWithClient({ status: "approved" });
    authorizedApp = app;
    t.after(async () => {
      authorizedApp = null;
      await cleanupTestApp(app);
    });

    const res = await putStarter(app.clientId, { includedUsdMicros: "7500000" });
    assert.equal(res.status, 200);
    assert.equal(res.body.includedUsdMicros, "7500000");

    const rows = await db
      .select({ includedUsdMicros: plans.includedUsdMicros })
      .from(plans)
      .where(and(eq(plans.clientId, app.clientId), eq(plans.isStarterDefault, true)))
      .limit(1);
    assert.equal(rows[0]?.includedUsdMicros, "7500000");
  });

  await t.test("PUT renames the starter plan", async (t) => {
    const app = await seedDeveloperAppWithClient({ status: "approved" });
    authorizedApp = app;
    t.after(async () => {
      authorizedApp = null;
      await cleanupTestApp(app);
    });

    const res = await putStarter(app.clientId, { name: "Free Trial" });
    assert.equal(res.status, 200);
    assert.equal(res.body.name, "Free Trial");

    const rows = await db
      .select({ name: plans.name })
      .from(plans)
      .where(and(eq(plans.clientId, app.clientId), eq(plans.isStarterDefault, true)))
      .limit(1);
    assert.equal(rows[0]?.name, "Free Trial");
  });

  await t.test("PUT disables and re-enables the starter plan", async (t) => {
    const app = await seedDeveloperAppWithClient({ status: "approved" });
    authorizedApp = app;
    t.after(async () => {
      authorizedApp = null;
      await cleanupTestApp(app);
    });

    const disabled = await putStarter(app.clientId, { status: "draft" });
    assert.equal(disabled.status, 200);
    assert.equal(disabled.body.status, "draft");

    const rows = await db
      .select({ status: plans.status })
      .from(plans)
      .where(and(eq(plans.clientId, app.clientId), eq(plans.isStarterDefault, true)))
      .limit(1);
    assert.equal(rows[0]?.status, "draft");

    const enabled = await putStarter(app.clientId, { status: "active" });
    assert.equal(enabled.status, 200);
    assert.equal(enabled.body.status, "active");
  });

  await t.test("POST custom plan named Starter is allowed after rename", async (t) => {
    const app = await seedDeveloperAppWithClient({ status: "approved" });
    authorizedApp = app;
    t.after(async () => {
      authorizedApp = null;
      await cleanupTestApp(app);
    });

    const renamed = await putStarter(app.clientId, { name: "Free Trial" });
    assert.equal(renamed.status, 200);

    const { POST } = await import("../plans/route");
    const blocked = await POST(
      new Request(`http://localhost/api/v1/apps/${app.clientId}/plans`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "Free Trial", type: "free" }),
      }),
      { params: Promise.resolve({ id: app.clientId }) },
    );
    assert.equal(blocked.status, 400);

    const allowed = await POST(
      new Request(`http://localhost/api/v1/apps/${app.clientId}/plans`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "Starter", type: "free" }),
      }),
      { params: Promise.resolve({ id: app.clientId }) },
    );
    assert.equal(allowed.status, 201);
  });

  await t.test("PUT rejects reserved Network Discovery name", async (t) => {
    const app = await seedDeveloperAppWithClient({ status: "approved" });
    authorizedApp = app;
    t.after(async () => {
      authorizedApp = null;
      await cleanupTestApp(app);
    });

    const res = await putStarter(app.clientId, { name: "Network Discovery" });
    assert.equal(res.status, 400);
    assert.ok(
      typeof res.body.error === "string" && res.body.error.includes("reserved"),
    );
  });

  await t.test("PUT rejects colliding custom plan name", async (t) => {
    const app = await seedDeveloperAppWithClient({ status: "approved" });
    authorizedApp = app;
    t.after(async () => {
      authorizedApp = null;
      await cleanupTestApp(app);
    });

    await db.insert(plans).values({
      id: `plan_${app.clientId}_pro`,
      clientId: app.clientId,
      name: "Pro",
      type: "subscription",
      priceAmount: "10",
      priceCurrency: "USD",
      status: "active",
      billingCycle: "monthly",
      isNetworkDefault: false,
      isStarterDefault: false,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    const res = await putStarter(app.clientId, { name: "Pro" });
    assert.equal(res.status, 400);
    assert.ok(
      typeof res.body.error === "string" && res.body.error.includes("already exists"),
    );
  });

  await t.test("PUT rejects empty body", async (t) => {
    const app = await seedDeveloperAppWithClient({ status: "approved" });
    authorizedApp = app;
    t.after(async () => {
      authorizedApp = null;
      await cleanupTestApp(app);
    });

    const res = await putStarter(app.clientId, {});
    assert.equal(res.status, 400);
    assert.ok(
      typeof res.body.error === "string" &&
        res.body.error.includes("name, status, or includedUsdMicros"),
    );
  });

  await t.test("PUT rejects invalid status", async (t) => {
    const app = await seedDeveloperAppWithClient({ status: "approved" });
    authorizedApp = app;
    t.after(async () => {
      authorizedApp = null;
      await cleanupTestApp(app);
    });

    const res = await putStarter(app.clientId, { status: "phase_out" });
    assert.equal(res.status, 400);
    assert.ok(typeof res.body.error === "string" && res.body.error.includes("status"));
  });
});
