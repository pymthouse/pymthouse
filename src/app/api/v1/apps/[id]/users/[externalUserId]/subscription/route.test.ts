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

test("subscription DELETE validates timing and requires confirm", async (t) => {
  const app = await seedDeveloperAppWithClient({ status: "approved" });
  authorizedApp = app;
  t.after(async () => {
    authorizedApp = null;
    await cleanupTestApp(app);
  });

  const { DELETE } = await import("./route");
  const params = {
    params: Promise.resolve({
      id: app.clientId,
      externalUserId: "user-1",
    }),
  };

  const badTiming = await DELETE(
    new NextRequest(
      `http://localhost/api/v1/apps/${app.clientId}/users/user-1/subscription`,
      {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ confirm: true, timing: "whenever" }),
      },
    ),
    params,
  );
  assert.equal(badTiming.status, 400);
  const badBody = (await badTiming.json()) as { error?: string };
  assert.match(String(badBody.error), /timing must be/);

  const unconfirmed = await DELETE(
    new NextRequest(
      `http://localhost/api/v1/apps/${app.clientId}/users/user-1/subscription`,
      {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ timing: "immediate" }),
      },
    ),
    params,
  );
  assert.equal(unconfirmed.status, 400);
  const unconfirmedBody = (await unconfirmed.json()) as {
    code?: string;
  };
  assert.equal(unconfirmedBody.code, "confirm_required");
});
