import assert from "node:assert/strict";
import { NextRequest } from "next/server";
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

test("subscription change route requires auth and planId", async (t) => {
  const app = await seedDeveloperAppWithClient({ status: "approved" });
  authorizedApp = app;
  t.after(async () => {
    authorizedApp = null;
    await cleanupTestApp(app);
  });

  const { POST } = await import("./route");

  const unauth = await POST(
    new NextRequest(
      `http://localhost/api/v1/apps/${app.clientId}/users/user-1/subscription/change`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ planId: "plan_x" }),
      },
    ),
    {
      params: Promise.resolve({
        id: "app_other",
        externalUserId: "user-1",
      }),
    },
  );
  assert.equal(unauth.status, 404);

  const missingPlan = await POST(
    new NextRequest(
      `http://localhost/api/v1/apps/${app.clientId}/users/user-1/subscription/change`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      },
    ),
    {
      params: Promise.resolve({
        id: app.clientId,
        externalUserId: "user-1",
      }),
    },
  );
  assert.equal(missingPlan.status, 400);
  const missingBody = (await missingPlan.json()) as { error?: string };
  assert.match(String(missingBody.error), /planId/);

  const badTiming = await POST(
    new NextRequest(
      `http://localhost/api/v1/apps/${app.clientId}/users/user-1/subscription/change`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ planId: "plan_x", timing: "whenever" }),
      },
    ),
    {
      params: Promise.resolve({
        id: app.clientId,
        externalUserId: "user-1",
      }),
    },
  );
  assert.equal(badTiming.status, 400);
});
