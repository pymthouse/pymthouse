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

test("splitCompositeApiKey parses app_*.pmth_* and rejects malformed forms", async () => {
  const { splitCompositeApiKey, formatCompositeApiKey, normalizeAppApiKeySubjectToken } =
    await import("@/lib/app-api-keys");

  const clientId = "app_3b386c81a1db1169fd2c3986";
  const otherClientId = "app_aaaaaaaaaaaaaaaaaaaaaaaa";

  assert.deepEqual(
    splitCompositeApiKey(`${clientId}.pmth_deadbeef`),
    { publicClientId: clientId, apiKey: "pmth_deadbeef" },
  );
  assert.equal(splitCompositeApiKey("pmth_deadbeef"), null);
  assert.equal(splitCompositeApiKey("app_abc:pmth_deadbeef"), null);
  assert.equal(splitCompositeApiKey("app_abc.pmth_cs_secret"), null);
  assert.equal(splitCompositeApiKey("app_ABC.pmth_x"), null);
  assert.equal(splitCompositeApiKey("app_abc123.pmth_deadbeef"), null);
  assert.equal(splitCompositeApiKey("app_nothexnothexnothexnot!.pmth_x"), null);

  assert.equal(
    formatCompositeApiKey(clientId, "pmth_deadbeef"),
    `${clientId}.pmth_deadbeef`,
  );
  assert.equal(
    normalizeAppApiKeySubjectToken(`${clientId}.pmth_deadbeef`, clientId),
    "pmth_deadbeef",
  );
  assert.equal(
    normalizeAppApiKeySubjectToken(`${otherClientId}.pmth_deadbeef`, clientId),
    null,
  );
  assert.equal(
    normalizeAppApiKeySubjectToken("pmth_deadbeef", clientId),
    "pmth_deadbeef",
  );
});

run("resolveActiveAppApiKey accepts composite app_*.pmth_* subject tokens", async (t) => {
  const app = await seedDeveloperAppWithClient({ status: "approved" });
  t.after(() => cleanupTestApp(app));

  const appUser = await createAppUser({
    clientId: app.clientId,
    externalUserId: `user-${randomUUID()}`,
  });
  const bare = `pmth_${"e".repeat(64)}`;
  const composite = `${app.clientId}.${bare}`;

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
    `app_otherclientid000.${bare}`,
    app.clientId,
  );
  assert.equal(mismatched, null);
});
