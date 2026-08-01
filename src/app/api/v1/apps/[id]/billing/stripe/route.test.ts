import assert from "node:assert/strict";
import type { Session } from "next-auth";

import { platformControlledFieldsError } from "@/lib/billing/platform-controlled-fields";
import { setProviderAppSessionResolverForTests } from "@/lib/provider-apps";
import { test } from "@/test-utils/db-guard";
import {
  cleanupTestApp,
  seedDeveloperAppWithClient,
  type SeededDeveloperApp,
} from "@/test-utils/fixtures";

function installSession(app: SeededDeveloperApp, role: "developer" | "admin") {
  setProviderAppSessionResolverForTests(async () => {
    return {
      user: {
        id: app.userId,
        role,
      },
      expires: new Date(Date.now() + 3_600_000).toISOString(),
    } as Session;
  });
}

test.after(() => {
  setProviderAppSessionResolverForTests(null);
});

test("PATCH /billing/stripe rejects platform-controlled fields for non-admins", async (t) => {
  const app = await seedDeveloperAppWithClient({ status: "approved" });
  installSession(app, "developer");
  t.after(async () => {
    setProviderAppSessionResolverForTests(null);
    await cleanupTestApp(app);
  });

  const { PATCH } = await import("./route");

  for (const field of ["applicationFeeBps", "endUserCap"] as const) {
    const body =
      field === "applicationFeeBps"
        ? { applicationFeeBps: 0 }
        : { endUserCap: 1_000_000 };
    const res = await PATCH(
      new Request(`http://localhost/api/v1/apps/${app.clientId}/billing/stripe`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }) as never,
      { params: Promise.resolve({ id: app.clientId }) },
    );
    assert.equal(res.status, 403, `${field} must 403 for non-admin`);
    const json = (await res.json()) as { error?: string };
    assert.equal(json.error, platformControlledFieldsError([field]));
  }
});

test("PATCH /billing/stripe allows platform-controlled fields for admins", async (t) => {
  const app = await seedDeveloperAppWithClient({ status: "approved" });
  installSession(app, "admin");
  t.after(async () => {
    setProviderAppSessionResolverForTests(null);
    await cleanupTestApp(app);
  });

  const { PATCH } = await import("./route");
  const res = await PATCH(
    new Request(`http://localhost/api/v1/apps/${app.clientId}/billing/stripe`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        endUserCap: 50,
        applicationFeeBps: 250,
      }),
    }) as never,
    { params: Promise.resolve({ id: app.clientId }) },
  );
  // Admin clears the 403 guard. Downstream OpenMeter/Stripe may still fail
  // without live credentials — those are not authorization failures.
  assert.notEqual(res.status, 403);
});
