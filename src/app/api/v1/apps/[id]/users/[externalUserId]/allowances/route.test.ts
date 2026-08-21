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

function grantRequest(clientId: string, externalUserId: string): NextRequest {
  return new NextRequest(
    `http://localhost/api/v1/apps/${clientId}/users/${encodeURIComponent(externalUserId)}/allowances`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ amountUsdMicros: "5000000", source: "manual" }),
    },
  );
}

test("POST allowances returns 403 free_grant_admin_only for app session", async (t) => {
  const app = await seedDeveloperAppWithClient({ status: "approved" });
  authorizedApp = app;
  t.after(async () => {
    authorizedApp = null;
    await cleanupTestApp(app);
  });

  const { POST } = await import("./route");

  const denied = await POST(grantRequest(app.clientId, "user-new"), {
    params: Promise.resolve({ id: app.clientId, externalUserId: "user-new" }),
  });
  assert.equal(denied.status, 403);
  assert.match(
    String(denied.headers.get("content-type")),
    /application\/problem\+json/,
  );
  const body = (await denied.json()) as { code?: string };
  assert.equal(body.code, "free_grant_admin_only");

  const ownerSubject = `owner:${app.userId}`;
  const ownerDenied = await POST(grantRequest(app.clientId, ownerSubject), {
    params: Promise.resolve({
      id: app.clientId,
      externalUserId: ownerSubject,
    }),
  });
  assert.equal(ownerDenied.status, 403);
  const ownerBody = (await ownerDenied.json()) as { code?: string };
  assert.equal(ownerBody.code, "free_grant_admin_only");
});
