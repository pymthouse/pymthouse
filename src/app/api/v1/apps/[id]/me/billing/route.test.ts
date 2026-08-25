import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

import { NextRequest } from "next/server";

import { run } from "@/test-utils/db-guard";
import {
  basicAuthHeader,
  cleanupTestApp,
  createAppUser,
  seedDeveloperAppWithClient,
} from "@/test-utils/fixtures";
import { db } from "@/db/index";
import { apiKeys } from "@/db/schema";
import { hashToken } from "@/lib/token-hash";

const ME_BILLING_GETS = [
  ["allowances", () => import("./allowances/route")],
  ["wallet", () => import("./wallet/route")],
  ["state", () => import("./state/route")],
  ["invoices", () => import("./invoices/route")],
  ["payment-methods", () => import("./payment-methods/route")],
  ["subscription", () => import("./subscription/route")],
] as const;

test("me billing routes reject subject overrides and require end-user auth", async () => {
  const clientId = "app_testdummyclientid000002";

  for (const [label, load] of ME_BILLING_GETS) {
    const { GET } = await load();
    const noAuth = await GET(
      new NextRequest(`http://localhost/api/v1/apps/${clientId}/me/billing/${label}`),
      { params: Promise.resolve({ id: clientId }) },
    );
    assert.equal(noAuth.status, 401, `${label} requires auth`);

    for (const key of ["userId", "externalUserId", "external_user_id"]) {
      const overridden = await GET(
        new NextRequest(
          `http://localhost/api/v1/apps/${clientId}/me/billing/${label}?${key}=other-user`,
        ),
        { params: Promise.resolve({ id: clientId }) },
      );
      assert.equal(overridden.status, 400, `${label} rejects ${key}`);
      const body = (await overridden.json()) as { error?: string };
      assert.match(body.error ?? "", /userId\/externalUserId/);
    }
  }
});

run("me billing GET rejects M2M Basic and scopes to the Bearer subject", async (t) => {
  const { GET } = await import("./allowances/route");
  const app = await seedDeveloperAppWithClient({ status: "approved" });
  t.after(() => cleanupTestApp(app));

  const m2m = await GET(
    new NextRequest(`http://localhost/api/v1/apps/${app.clientId}/me/billing/allowances`, {
      headers: {
        Authorization: basicAuthHeader(app.clientId, app.clientSecret),
      },
    }),
    { params: Promise.resolve({ id: app.clientId }) },
  );
  assert.equal(m2m.status, 401);

  const externalUserId = `user-${randomUUID()}`;
  const appUser = await createAppUser({
    clientId: app.clientId,
    externalUserId,
  });
  const bare = `pmth_${randomUUID().replaceAll("-", "")}${"e".repeat(32)}`;
  await db.insert(apiKeys).values({
    id: `key-${randomUUID()}`,
    keyHash: hashToken(bare),
    clientId: app.clientId,
    appUserId: appUser.id,
    label: "end-user key",
    status: "active",
  });

  const wrongApp = await GET(
    new NextRequest(
      "http://localhost/api/v1/apps/app_otherclientid0000000002/me/billing/allowances",
      { headers: { Authorization: `Bearer ${bare}` } },
    ),
    { params: Promise.resolve({ id: "app_otherclientid0000000002" }) },
  );
  assert.equal(wrongApp.status, 401);
});
