import assert from "node:assert/strict";
import { NextRequest } from "next/server";
import { test } from "@/test-utils/db-guard";
import { __testSetSpendableLookup } from "@/lib/activation/app-activation";
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

test("granting to a new end-user clears the provision gate", async (t) => {
  const app = await seedDeveloperAppWithClient({ status: "approved" });
  authorizedApp = app;
  t.after(async () => {
    authorizedApp = null;
    await cleanupTestApp(app);
  });

  // Dry owner wallet: creating a new end-user must be denied on the cost rail.
  __testSetSpendableLookup(async () => "0");
  t.after(() => __testSetSpendableLookup(null));

  const prev = process.env.ACTIVATION_GATE_MODE;
  process.env.ACTIVATION_GATE_MODE = "enforce";
  t.after(() => {
    if (prev === undefined) delete process.env.ACTIVATION_GATE_MODE;
    else process.env.ACTIVATION_GATE_MODE = prev;
  });

  const { POST } = await import("./route");

  const denied = await POST(grantRequest(app.clientId, "user-new"), {
    params: Promise.resolve({ id: app.clientId, externalUserId: "user-new" }),
  });
  assert.equal(denied.status, 402);
  assert.match(
    String(denied.headers.get("content-type")),
    /application\/problem\+json/,
  );
  const body = (await denied.json()) as { code?: string };
  assert.equal(body.code, "owner_balance_exhausted");

  // The owner topping up their own wallet is the way out of that denial.
  const ownerSubject = `owner:${app.userId}`;
  const ownerTopUp = await POST(grantRequest(app.clientId, ownerSubject), {
    params: Promise.resolve({
      id: app.clientId,
      externalUserId: ownerSubject,
    }),
  });
  assert.notEqual(ownerTopUp.status, 402);
});
