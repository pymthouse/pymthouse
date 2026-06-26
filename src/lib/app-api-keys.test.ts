import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { randomUUID } from "node:crypto";

import { run } from "@/test-utils/db-guard";
import { cleanupTestApp, createAppUser, seedDeveloperAppWithClient } from "@/test-utils/fixtures";
import { db } from "@/db/index";
import { apiKeys } from "@/db/schema";
import { resolveActiveAppApiKey } from "@/lib/app-api-keys";
import { hashToken } from "@/lib/token-hash";

run("resolveActiveAppApiKey accepts per-app-user keys", async (t) => {
  const app = await seedDeveloperAppWithClient({ status: "approved" });
  t.after(() => cleanupTestApp(app));

  const appUser = await createAppUser({
    clientId: app.clientId,
    externalUserId: `user-${randomUUID()}`,
  });
  const token = `pmth_${"a".repeat(64)}`;

  await db.insert(apiKeys).values({
    id: `key-${randomUUID()}`,
    keyHash: hashToken(token),
    clientId: app.clientId,
    appUserId: appUser.id,
    label: "per-user key",
    status: "active",
  });

  const resolved = await resolveActiveAppApiKey(token, app.clientId);
  assert.ok(resolved);
  assert.equal(resolved?.appUserId, appUser.id);
  assert.equal(resolved?.publicClientId, app.clientId);
});

run("resolveActiveAppApiKey rejects keys without app_user_id", async (t) => {
  const app = await seedDeveloperAppWithClient({ status: "approved" });
  t.after(() => cleanupTestApp(app));

  const token = `pmth_${"b".repeat(64)}`;

  await db.insert(apiKeys).values({
    id: `key-${randomUUID()}`,
    keyHash: hashToken(token),
    clientId: app.clientId,
    userId: app.userId,
    label: "old app-level key",
    status: "active",
  });

  const resolved = await resolveActiveAppApiKey(token, app.clientId);
  assert.equal(resolved, null);
});

run("resolveActiveAppApiKey rejects legacy SHA-256 key hashes", async (t) => {
  const app = await seedDeveloperAppWithClient({ status: "approved" });
  t.after(() => cleanupTestApp(app));

  const appUser = await createAppUser({
    clientId: app.clientId,
    externalUserId: `user-${randomUUID()}`,
  });
  const token = `pmth_${"c".repeat(64)}`;

  await db.insert(apiKeys).values({
    id: `key-${randomUUID()}`,
    keyHash: createHash("sha256").update(token).digest("hex"),
    clientId: app.clientId,
    appUserId: appUser.id,
    label: "legacy hash key",
    status: "active",
  });

  const resolved = await resolveActiveAppApiKey(token, app.clientId);
  assert.equal(resolved, null);
});

run("resolveActiveAppApiKey rejects keys for a different public client_id", async (t) => {
  const app = await seedDeveloperAppWithClient({ status: "approved" });
  const other = await seedDeveloperAppWithClient({ status: "approved" });
  t.after(async () => {
    await cleanupTestApp(app);
    await cleanupTestApp(other);
  });

  const appUser = await createAppUser({
    clientId: app.clientId,
    externalUserId: `user-${randomUUID()}`,
  });
  const token = `pmth_${"d".repeat(64)}`;

  await db.insert(apiKeys).values({
    id: `key-${randomUUID()}`,
    keyHash: hashToken(token),
    clientId: app.clientId,
    appUserId: appUser.id,
    status: "active",
  });

  const resolved = await resolveActiveAppApiKey(token, other.clientId);
  assert.equal(resolved, null);
});

test("resolveActiveAppApiKey returns null for non-pmth tokens without DB", async () => {
  const resolved = await resolveActiveAppApiKey("sk_not_pmth", "app_test");
  assert.equal(resolved, null);
});
