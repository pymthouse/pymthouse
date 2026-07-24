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

test("starter-plan API", async (t) => {
  await t.test("PUT updates includedUsdMicros", async (t) => {
    const app = await seedDeveloperAppWithClient({ status: "approved" });
    authorizedApp = app;
    t.after(async () => {
      authorizedApp = null;
      await cleanupTestApp(app);
    });

    const { PUT } = await import("./route");
    const res = await PUT(
      new Request(`http://localhost/api/v1/apps/${app.clientId}/starter-plan`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ includedUsdMicros: "7500000" }),
      }),
      { params: Promise.resolve({ id: app.clientId }) },
    );
    assert.equal(res.status, 200);
    const body = (await res.json()) as { includedUsdMicros?: string };
    assert.equal(body.includedUsdMicros, "7500000");

    const rows = await db
      .select({ includedUsdMicros: plans.includedUsdMicros })
      .from(plans)
      .where(and(eq(plans.clientId, app.clientId), eq(plans.isStarterDefault, true)))
      .limit(1);
    assert.equal(rows[0]?.includedUsdMicros, "7500000");
  });
});
