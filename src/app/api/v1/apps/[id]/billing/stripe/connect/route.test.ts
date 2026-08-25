import assert from "node:assert/strict";
import type { Session } from "next-auth";

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

test("POST /billing/stripe/connect rejects non-boolean stripeLivemode", async (t) => {
  const app = await seedDeveloperAppWithClient({ status: "approved" });
  installSession(app, "developer");
  t.after(async () => {
    setProviderAppSessionResolverForTests(null);
    await cleanupTestApp(app);
  });

  const { POST } = await import("./route");
  const res = await POST(
    new Request(
      `http://localhost/api/v1/apps/${app.clientId}/billing/stripe/connect`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mode: "account_link", stripeLivemode: "true" }),
      },
    ) as never,
    { params: Promise.resolve({ id: app.clientId }) },
  );
  assert.equal(res.status, 400);
  const json = (await res.json()) as { error?: string };
  assert.equal(json.error, "stripeLivemode must be a boolean");
});
