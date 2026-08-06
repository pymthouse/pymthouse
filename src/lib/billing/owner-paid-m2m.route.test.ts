import assert from "node:assert/strict";
import { NextRequest } from "next/server";

import { test } from "@/test-utils/db-guard";
import {
  basicAuthHeader,
  cleanupTestApp,
  seedDeveloperAppWithClient,
} from "@/test-utils/fixtures";

function authHeaders(clientId: string, clientSecret: string): HeadersInit {
  return {
    Authorization: basicAuthHeader(clientId, clientSecret),
    "Content-Type": "application/json",
  };
}

test("owner-paid M2M routes reject missing/wrong Basic auth", async (t) => {
  const app = await seedDeveloperAppWithClient({ status: "approved" });
  t.after(async () => {
    await cleanupTestApp(app);
  });

  const { GET: getTiers } = await import("@/app/api/v1/apps/[id]/billing/owner-tiers/route");
  const { POST: upgrade } = await import("@/app/api/v1/apps/[id]/billing/upgrade-paid/route");

  const unauth = await getTiers(
    new NextRequest(
      `http://localhost/api/v1/apps/${app.clientId}/billing/owner-tiers`,
    ),
    { params: Promise.resolve({ id: app.clientId }) },
  );
  assert.equal(unauth.status, 404);

  const wrongApp = await upgrade(
    new NextRequest(
      `http://localhost/api/v1/apps/${app.clientId}/billing/upgrade-paid`,
      {
        method: "POST",
        headers: authHeaders(app.clientId, app.clientSecret),
        body: JSON.stringify({ planKey: "pymthouse_owner_paid", confirm: true }),
      },
    ),
    { params: Promise.resolve({ id: "app_other_client" }) },
  );
  assert.equal(wrongApp.status, 404);
});

test("owner-paid M2M upgrade/downgrade/resume require confirm: true", async (t) => {
  const app = await seedDeveloperAppWithClient({ status: "approved" });
  t.after(async () => {
    await cleanupTestApp(app);
  });

  const { POST: upgrade } = await import("@/app/api/v1/apps/[id]/billing/upgrade-paid/route");
  const { POST: downgrade } = await import("@/app/api/v1/apps/[id]/billing/downgrade-to-starter/route");
  const { POST: resume } = await import("@/app/api/v1/apps/[id]/billing/resume-paid-plan/route");

  const upgradeRes = await upgrade(
    new NextRequest(
      `http://localhost/api/v1/apps/${app.clientId}/billing/upgrade-paid`,
      {
        method: "POST",
        headers: authHeaders(app.clientId, app.clientSecret),
        body: JSON.stringify({ planKey: "pymthouse_owner_paid" }),
      },
    ),
    { params: Promise.resolve({ id: app.clientId }) },
  );
  assert.equal(upgradeRes.status, 400);
  const upgradeBody = (await upgradeRes.json()) as { code?: string };
  assert.equal(upgradeBody.code, "confirm_required");

  const downgradeRes = await downgrade(
    new NextRequest(
      `http://localhost/api/v1/apps/${app.clientId}/billing/downgrade-to-starter`,
      {
        method: "POST",
        headers: authHeaders(app.clientId, app.clientSecret),
        body: JSON.stringify({}),
      },
    ),
    { params: Promise.resolve({ id: app.clientId }) },
  );
  assert.equal(downgradeRes.status, 400);
  const downgradeBody = (await downgradeRes.json()) as { code?: string };
  assert.equal(downgradeBody.code, "confirm_required");

  const resumeRes = await resume(
    new NextRequest(
      `http://localhost/api/v1/apps/${app.clientId}/billing/resume-paid-plan`,
      {
        method: "POST",
        headers: authHeaders(app.clientId, app.clientSecret),
        body: JSON.stringify({ confirm: false }),
      },
    ),
    { params: Promise.resolve({ id: app.clientId }) },
  );
  assert.equal(resumeRes.status, 400);
  const resumeBody = (await resumeRes.json()) as { code?: string };
  assert.equal(resumeBody.code, "confirm_required");
});

test("owner-tiers M2M lists selectable tiers with Basic auth", async (t) => {
  const app = await seedDeveloperAppWithClient({ status: "approved" });
  t.after(async () => {
    await cleanupTestApp(app);
  });

  const { GET } = await import("@/app/api/v1/apps/[id]/billing/owner-tiers/route");
  const res = await GET(
    new NextRequest(
      `http://localhost/api/v1/apps/${app.clientId}/billing/owner-tiers`,
      {
        headers: { Authorization: basicAuthHeader(app.clientId, app.clientSecret) },
      },
    ),
    { params: Promise.resolve({ id: app.clientId }) },
  );
  assert.equal(res.status, 200);
  const body = (await res.json()) as { tiers?: unknown };
  assert.ok(Array.isArray(body.tiers));
});

test("payment-method PATCH/DELETE require paymentMethodId under M2M", async (t) => {
  const app = await seedDeveloperAppWithClient({ status: "approved" });
  t.after(async () => {
    await cleanupTestApp(app);
  });

  const { PATCH, DELETE } = await import("@/app/api/v1/apps/[id]/billing/payment-method/route");

  const patchRes = await PATCH(
    new NextRequest(
      `http://localhost/api/v1/apps/${app.clientId}/billing/payment-method`,
      {
        method: "PATCH",
        headers: authHeaders(app.clientId, app.clientSecret),
        body: JSON.stringify({}),
      },
    ),
    { params: Promise.resolve({ id: app.clientId }) },
  );
  assert.equal(patchRes.status, 400);

  const deleteRes = await DELETE(
    new NextRequest(
      `http://localhost/api/v1/apps/${app.clientId}/billing/payment-method`,
      {
        method: "DELETE",
        headers: authHeaders(app.clientId, app.clientSecret),
        body: JSON.stringify({}),
      },
    ),
    { params: Promise.resolve({ id: app.clientId }) },
  );
  assert.equal(deleteRes.status, 400);
});
