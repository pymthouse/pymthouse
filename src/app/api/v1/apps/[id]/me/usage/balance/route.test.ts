import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import { NextRequest } from "next/server";

import { test } from "@/test-utils/db-guard";
import {
  cleanupTestApp,
  createAppUser,
  seedDeveloperAppWithClient,
} from "@/test-utils/fixtures";
import { db } from "@/db/index";
import { apiKeys } from "@/db/schema";
import { hashToken } from "@/lib/token-hash";

test("me usage balance rejects externalUserId override with bare Bearer", async (t) => {
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

  const unauthorized = await GET(
    new NextRequest(
      `http://localhost/api/v1/apps/${app.clientId}/me/usage/balance`,
    ),
    { params: Promise.resolve({ id: app.clientId }) },
  );
  assert.equal(unauthorized.status, 401);

  const bad = await GET(
    new NextRequest(
      `http://localhost/api/v1/apps/${app.clientId}/me/usage/balance?externalUserId=other`,
      { headers: { Authorization: `Bearer ${bare}` } },
    ),
    { params: Promise.resolve({ id: app.clientId }) },
  );
  assert.equal(bad.status, 400);
});
