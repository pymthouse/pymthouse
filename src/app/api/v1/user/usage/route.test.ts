import test from "node:test";
import assert from "node:assert/strict";
import { NextRequest } from "next/server";

test("end-user usage routes reject subject overrides and require auth", async () => {
  const usage = await import("./route");
  const balance = await import("./balance/route");

  for (const [label, GET] of [
    ["usage", usage.GET],
    ["balance", balance.GET],
  ] as const) {
    const noAuth = await GET(
      new NextRequest(`http://localhost/api/v1/user/${label}`),
    );
    assert.equal(noAuth.status, 401, `${label} requires auth`);

    for (const key of ["userId", "externalUserId", "external_user_id"]) {
      const overridden = await GET(
        new NextRequest(
          `http://localhost/api/v1/user/${label}?${key}=other-user`,
        ),
      );
      assert.equal(overridden.status, 400, `${label} rejects ${key}`);
      const body = (await overridden.json()) as { error?: string };
      assert.match(body.error ?? "", /userId\/externalUserId/);
    }
  }
});

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import { run } from "@/test-utils/db-guard";
import {
  cleanupTestApp,
  createAppUser,
  seedDeveloperAppWithClient,
} from "@/test-utils/fixtures";
import { db } from "@/db/index";
import { apiKeys } from "@/db/schema";
import { formatCompositeApiKey } from "@/lib/app-api-keys";
import {
  __testClearOpenMeterUsageStubs,
  __testSetOpenMeterUsageRows,
} from "@/lib/openmeter/usage-read";
import { hashToken } from "@/lib/token-hash";

run("user usage API requires end-user Bearer and scopes to that user", async (t) => {
  const { GET } = await import("./route");
  const app = await seedDeveloperAppWithClient({ status: "approved" });
  t.after(() => cleanupTestApp(app));

  const anonymous = await GET(new Request("http://localhost/api/v1/user/usage"));
  assert.equal(anonymous.status, 401);

  const externalUserId = `user-${randomUUID()}`;
  const appUser = await createAppUser({
    clientId: app.clientId,
    externalUserId,
  });
  const bare = `pmth_${"e".repeat(64)}`;
  await db.insert(apiKeys).values({
    id: `key-${randomUUID()}`,
    keyHash: hashToken(bare),
    clientId: app.clientId,
    appUserId: appUser.id,
    label: "end-user key",
    status: "active",
  });
  const composite = formatCompositeApiKey(app.clientId, bare);

  const rejectedOverride = await GET(
    new Request("http://localhost/api/v1/user/usage?externalUserId=other", {
      headers: { Authorization: `Bearer ${composite}` },
    }),
  );
  assert.equal(rejectedOverride.status, 400);

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
    new Request("http://localhost/api/v1/user/usage?groupBy=user", {
      headers: { Authorization: `Bearer ${composite}` },
    }),
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
