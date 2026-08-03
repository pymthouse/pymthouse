import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

import { NextRequest } from "next/server";

import { run } from "@/test-utils/db-guard";
import {
  cleanupTestApp,
  createAppUser,
  seedDeveloperAppWithClient,
} from "@/test-utils/fixtures";
import { db } from "@/db/index";
import { apiKeys } from "@/db/schema";
import {
  __testClearOpenMeterUsageStubs,
  __testSetOpenMeterUsageRows,
} from "@/lib/openmeter/usage-read";
import { hashToken } from "@/lib/token-hash";

test("me usage routes reject subject overrides and require auth", async () => {
  const usage = await import("./route");
  const balance = await import("./balance/route");
  const clientId = "app_testdummyclientid000001";

  for (const [label, GET] of [
    ["usage", usage.GET],
    ["balance", balance.GET],
  ] as const) {
    const noAuth = await GET(
      new NextRequest(`http://localhost/api/v1/apps/${clientId}/me/${label}`),
      { params: Promise.resolve({ id: clientId }) },
    );
    assert.equal(noAuth.status, 401, `${label} requires auth`);

    for (const key of ["userId", "externalUserId", "external_user_id"]) {
      const overridden = await GET(
        new NextRequest(
          `http://localhost/api/v1/apps/${clientId}/me/${label}?${key}=other-user`,
        ),
        { params: Promise.resolve({ id: clientId }) },
      );
      assert.equal(overridden.status, 400, `${label} rejects ${key}`);
      const body = (await overridden.json()) as { error?: string };
      assert.match(body.error ?? "", /userId\/externalUserId/);
    }
  }
});

run("me usage API accepts bare Bearer and scopes to that user", async (t) => {
  const { GET } = await import("./route");
  const app = await seedDeveloperAppWithClient({ status: "approved" });
  t.after(() => cleanupTestApp(app));

  const anonymous = await GET(
    new NextRequest(`http://localhost/api/v1/apps/${app.clientId}/me/usage`),
    { params: Promise.resolve({ id: app.clientId }) },
  );
  assert.equal(anonymous.status, 401);

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

  const rejectedOverride = await GET(
    new NextRequest(
      `http://localhost/api/v1/apps/${app.clientId}/me/usage?externalUserId=other`,
      { headers: { Authorization: `Bearer ${bare}` } },
    ),
    { params: Promise.resolve({ id: app.clientId }) },
  );
  assert.equal(rejectedOverride.status, 400);

  const wrongApp = await GET(
    new NextRequest(
      "http://localhost/api/v1/apps/app_otherclientid0000000001/me/usage?groupBy=user",
      { headers: { Authorization: `Bearer ${bare}` } },
    ),
    { params: Promise.resolve({ id: "app_otherclientid0000000001" }) },
  );
  assert.equal(wrongApp.status, 401);

  __testSetOpenMeterUsageRows(app.clientId, [
    {
      externalUserId,
      requestCount: 2,
      networkFeeUsdMicros: "32",
    },
    {
      externalUserId: "someone-else",
      requestCount: 9,
      networkFeeUsdMicros: "999",
    },
  ]);
  t.after(() => __testClearOpenMeterUsageStubs());

  const ok = await GET(
    new NextRequest(
      `http://localhost/api/v1/apps/${app.clientId}/me/usage?groupBy=user`,
      { headers: { Authorization: `Bearer ${bare}` } },
    ),
    { params: Promise.resolve({ id: app.clientId }) },
  );
  assert.equal(ok.status, 200);
  const body = (await ok.json()) as {
    totals: { requestCount: number; networkFeeUsdMicros: string };
    byUser?: Array<{ externalUserId: string; requestCount: number }>;
  };
  assert.equal(body.totals.requestCount, 2);
  assert.equal(body.totals.networkFeeUsdMicros, "32");
  assert.equal(body.byUser?.length, 1);
  assert.equal(body.byUser?.[0]?.externalUserId, externalUserId);
});
