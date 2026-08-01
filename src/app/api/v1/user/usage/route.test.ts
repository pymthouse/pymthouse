import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import { NextRequest } from "next/server";

import { db } from "@/db/index";
import { apiKeys } from "@/db/schema";
import {
  __testClearOpenMeterUsageStubs,
  __testSetOpenMeterUsageRows,
} from "@/lib/openmeter/usage-read";
import { hashToken } from "@/lib/token-hash";
import { run } from "@/test-utils/db-guard";
import {
  cleanupTestApp,
  createAppUser,
  seedDeveloperAppWithClient,
} from "@/test-utils/fixtures";

run("/user/usage accepts bare Bearer and scopes to that user", async (t) => {
  const { GET } = await import("./route");
  const app = await seedDeveloperAppWithClient({ status: "approved" });
  t.after(() => cleanupTestApp(app));

  const anonymous = await GET(
    new NextRequest("http://localhost/api/v1/user/usage"),
  );
  assert.equal(anonymous.status, 401);

  const externalUserId = `user-${randomUUID()}`;
  const appUser = await createAppUser({
    clientId: app.clientId,
    externalUserId,
  });
  const bare = `pmth_${randomUUID().replaceAll("-", "")}${"d".repeat(32)}`;
  await db.insert(apiKeys).values({
    id: `key-${randomUUID()}`,
    keyHash: hashToken(bare),
    clientId: app.clientId,
    appUserId: appUser.id,
    label: "end-user key",
    status: "active",
  });

  const rejectedOverride = await GET(
    new NextRequest("http://localhost/api/v1/user/usage?externalUserId=other", {
      headers: { Authorization: `Bearer ${bare}` },
    }),
  );
  assert.equal(rejectedOverride.status, 400);

  __testSetOpenMeterUsageRows(app.clientId, [
    { externalUserId, requestCount: 2, networkFeeUsdMicros: "32" },
    { externalUserId: "someone-else", requestCount: 9, networkFeeUsdMicros: "999" },
  ]);
  t.after(() => __testClearOpenMeterUsageStubs());

  const ok = await GET(
    new NextRequest("http://localhost/api/v1/user/usage?groupBy=user", {
      headers: { Authorization: `Bearer ${bare}` },
    }),
  );
  assert.equal(ok.status, 200);
  const body = (await ok.json()) as {
    totals: { requestCount: number; networkFeeUsdMicros: string };
    byUser?: Array<{ externalUserId: string }>;
  };
  assert.equal(body.totals.requestCount, 2);
  assert.equal(body.totals.networkFeeUsdMicros, "32");
  assert.equal(body.byUser?.length, 1);
  assert.equal(body.byUser?.[0]?.externalUserId, externalUserId);
});
