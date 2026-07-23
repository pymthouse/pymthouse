import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import { NextRequest } from "next/server";

import { run } from "@/test-utils/db-guard";
import {
  cleanupTestApp,
  createAppUser,
  seedDeveloperAppWithClient,
} from "@/test-utils/fixtures";
import { db } from "@/db/index";
import { apiKeys } from "@/db/schema";
import { formatCompositeApiKey } from "@/lib/app-api-keys";
import { hashToken } from "@/lib/token-hash";

run("user usage balance rejects externalUserId override", async (t) => {
  const { GET } = await import("./route");
  const app = await seedDeveloperAppWithClient({ status: "approved" });
  t.after(() => cleanupTestApp(app));

  const externalUserId = `user-${randomUUID()}`;
  const appUser = await createAppUser({
    clientId: app.clientId,
    externalUserId,
  });
  const bare = `pmth_${randomUUID().replaceAll("-", "")}${"f".repeat(32)}`;
  await db.insert(apiKeys).values({
    id: `key-${randomUUID()}`,
    keyHash: hashToken(bare),
    clientId: app.clientId,
    appUserId: appUser.id,
    label: "end-user key",
    status: "active",
  });
  const composite = formatCompositeApiKey(app.clientId, bare);

  const unauthorized = await GET(
    new NextRequest("http://localhost/api/v1/user/usage/balance"),
  );
  assert.equal(unauthorized.status, 401);

  const bad = await GET(
    new NextRequest(
      "http://localhost/api/v1/user/usage/balance?externalUserId=other",
      { headers: { Authorization: `Bearer ${composite}` } },
    ),
  );
  assert.equal(bad.status, 400);
});
