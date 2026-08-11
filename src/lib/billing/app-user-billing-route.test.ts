import assert from "node:assert/strict";
import { NextRequest } from "next/server";

import { test } from "@/test-utils/db-guard";
import {
  basicAuthHeader,
  cleanupTestApp,
  seedDeveloperAppWithClient,
} from "@/test-utils/fixtures";
import {
  ensureM2mBackendClient,
  removeM2mBackendClient,
  rotateClientSecret,
} from "@/lib/oidc/clients";

import {
  authorizeAppUserBillingRoute,
  isAppUserBillingAccess,
} from "./app-user-billing-route";

test("authorizeAppUserBillingRoute returns 400 for malformed externalUserId", async () => {
  const res = await authorizeAppUserBillingRoute(
    new NextRequest("http://localhost/x"),
    "app_1",
    "%E0%A4%A",
  );
  assert.equal(isAppUserBillingAccess(res), false);
  assert.equal((res as Response).status, 400);
});

test("authorizeAppUserBillingRoute accepts M2M Basic for a seeded app", async (t) => {
  const app = await seedDeveloperAppWithClient({ status: "approved" });
  t.after(async () => {
    await removeM2mBackendClient(app.clientId).catch(() => undefined);
    await cleanupTestApp(app);
  });
  const m2m = await ensureM2mBackendClient({
    appInternalId: app.clientId,
    appDisplayName: "App user billing",
  });
  assert.ok(m2m);
  const secret = await rotateClientSecret(m2m.clientId);
  assert.ok(secret);

  const access = await authorizeAppUserBillingRoute(
    new NextRequest(
      `http://localhost/api/v1/apps/${app.clientId}/users/eu_1/invoices`,
      {
        headers: {
          Authorization: basicAuthHeader(m2m.clientId, secret),
        },
      },
    ),
    app.clientId,
    "eu_1",
  );
  assert.ok(isAppUserBillingAccess(access));
  assert.equal(access.externalUserId, "eu_1");
  assert.equal(access.app.id, app.clientId);
});
