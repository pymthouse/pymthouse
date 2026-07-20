import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { randomUUID } from "node:crypto";

import { test } from "@/test-utils/db-guard";
import { cleanupTestApp, createAppUser, seedDeveloperAppWithClient } from "@/test-utils/fixtures";
import { db } from "@/db/index";
import { apiKeys } from "@/db/schema";
import { resolveActiveAppApiKey } from "@/lib/app-api-keys";
import { hashToken } from "@/lib/token-hash";

test("resolveActiveAppApiKey accepts per-app-user keys", async (t) => {
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

test("resolveActiveAppApiKey rejects keys without app_user_id", async (t) => {
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

test("resolveActiveAppApiKey rejects legacy SHA-256 key hashes", async (t) => {
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

test("resolveActiveAppApiKey rejects keys for a different public client_id", async (t) => {
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

test("resolveActiveAppApiKey returns null for non-api-key tokens without DB", async () => {
  const resolved = await resolveActiveAppApiKey("sk_not_api_key", "app_test");
  assert.equal(resolved, null);
});

test("splitCompositeApiKey parses app_*_* and rejects malformed forms", async () => {
  const { splitCompositeApiKey, formatCompositeApiKey, normalizeAppApiKeySubjectToken } =
    await import("@/lib/app-api-keys");

  const clientId = "app_3b386c81a1db1169fd2c3986";
  const otherClientId = "app_aaaaaaaaaaaaaaaaaaaaaaaa";
  const bare = "pmth_deadbeef";
  const composite = `${clientId}_${bare}`;

  assert.deepEqual(splitCompositeApiKey(composite), {
    publicClientId: clientId,
    apiKey: bare,
  });
  assert.equal(splitCompositeApiKey("deadbeef"), null);
  assert.equal(splitCompositeApiKey(`${clientId}.deadbeef`), null);
  assert.equal(splitCompositeApiKey(`${clientId}_cs_secret`), null);
  assert.equal(splitCompositeApiKey("app_short_x"), null);

  assert.equal(formatCompositeApiKey(clientId, bare), composite);
  assert.equal(normalizeAppApiKeySubjectToken(composite, clientId), bare);
  assert.equal(
    normalizeAppApiKeySubjectToken(`${otherClientId}_${bare}`, clientId),
    null,
  );
  assert.equal(normalizeAppApiKeySubjectToken(bare, clientId), bare);
  assert.equal(normalizeAppApiKeySubjectToken("deadbeef", clientId), "pmth_deadbeef");
});

test("resolveActiveAppApiKey accepts composite app_*_* subject tokens", async (t) => {
  const app = await seedDeveloperAppWithClient({ status: "approved" });
  t.after(() => cleanupTestApp(app));

  const appUser = await createAppUser({
    clientId: app.clientId,
    externalUserId: `user-${randomUUID()}`,
  });
  const bare = `pmth_${"e".repeat(64)}`;
  const composite = `${app.clientId}_${bare}`;

  await db.insert(apiKeys).values({
    id: `key-${randomUUID()}`,
    keyHash: hashToken(bare),
    clientId: app.clientId,
    appUserId: appUser.id,
    label: "composite key",
    status: "active",
  });

  const resolved = await resolveActiveAppApiKey(composite, app.clientId);
  assert.ok(resolved);
  assert.equal(resolved?.appUserId, appUser.id);
  assert.equal(resolved?.publicClientId, app.clientId);

  const mismatched = await resolveActiveAppApiKey(
    `app_aaaaaaaaaaaaaaaaaaaaaaaa_${bare}`,
    app.clientId,
  );
  assert.equal(mismatched, null);
});
