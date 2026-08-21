import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";

import { test } from "@/test-utils/db-guard";
import {
  cleanupTestApp,
  createTestUser,
  seedDeveloperAppWithClient,
} from "@/test-utils/fixtures";
import { withTemporaryPlatformDefault } from "@/test-utils/platform-default-lock";
import { db } from "@/db/index";
import { appUsers, users } from "@/db/schema";
import {
  createAppUserApiKey,
  listSessionUserApiKeys,
  revokeSessionUserApiKey,
} from "@/lib/app-api-keys";

test("listSessionUserApiKeys excludes spoofed external_user_id on foreign apps", async (t) => {
  const victimId = await createTestUser({ role: "developer" });
  const attackerApp = await seedDeveloperAppWithClient({
    name: `Attacker ${randomUUID().slice(0, 8)}`,
  });
  t.after(async () => {
    await cleanupTestApp(attackerApp);
    await db.delete(users).where(eq(users.id, victimId));
  });

  const spoofedAppUserId = randomUUID();
  await db.insert(appUsers).values({
    id: spoofedAppUserId,
    clientId: attackerApp.clientId,
    externalUserId: victimId,
    status: "active",
    role: "user",
    createdAt: new Date().toISOString(),
  });

  const spoofedKey = await createAppUserApiKey({
    developerAppId: attackerApp.clientId,
    appUserId: spoofedAppUserId,
    label: "spoofed",
  });

  const listed = await listSessionUserApiKeys(victimId);
  assert.equal(
    listed.some((row) => row.id === spoofedKey.id),
    false,
    "victim must not see keys from an app they do not own",
  );

  const revoked = await revokeSessionUserApiKey({
    sessionUserId: victimId,
    keyId: spoofedKey.id,
  });
  assert.equal(revoked, null);
});

test("list/revoke session keys allow personal default and owned-app keys", async (t) => {
  const ownerApp = await seedDeveloperAppWithClient({
    name: `Owned ${randomUUID().slice(0, 8)}`,
  });
  const defaultApp = await seedDeveloperAppWithClient({
    name: `Default ${randomUUID().slice(0, 8)}`,
  });
  t.after(async () => {
    await cleanupTestApp(defaultApp);
    await cleanupTestApp(ownerApp);
  });

  await withTemporaryPlatformDefault(defaultApp.clientId, async () => {
    const personalUserId = randomUUID();
    await db.insert(appUsers).values({
      id: personalUserId,
      clientId: defaultApp.clientId,
      externalUserId: ownerApp.userId,
      status: "active",
      role: "user",
      createdAt: new Date().toISOString(),
    });
    const personalKey = await createAppUserApiKey({
      developerAppId: defaultApp.clientId,
      appUserId: personalUserId,
      label: "personal",
    });

    const ownerAppUserId = randomUUID();
    await db.insert(appUsers).values({
      id: ownerAppUserId,
      clientId: ownerApp.clientId,
      externalUserId: ownerApp.userId,
      status: "active",
      role: "user",
      createdAt: new Date().toISOString(),
    });
    const ownerKey = await createAppUserApiKey({
      developerAppId: ownerApp.clientId,
      appUserId: ownerAppUserId,
      label: "owner",
    });

    const listed = await listSessionUserApiKeys(ownerApp.userId);
    const ids = new Set(listed.map((row) => row.id));
    assert.equal(ids.has(personalKey.id), true);
    assert.equal(ids.has(ownerKey.id), true);
    assert.equal(
      listed.find((row) => row.id === personalKey.id)?.isPlatformDefault,
      true,
    );

    assert.deepEqual(
      await revokeSessionUserApiKey({
        sessionUserId: ownerApp.userId,
        keyId: personalKey.id,
      }),
      { developerAppId: defaultApp.clientId },
    );
    assert.deepEqual(
      await revokeSessionUserApiKey({
        sessionUserId: ownerApp.userId,
        keyId: ownerKey.id,
      }),
      { developerAppId: ownerApp.clientId },
    );

    const after = await listSessionUserApiKeys(ownerApp.userId);
    assert.equal(
      after.find((row) => row.id === personalKey.id)?.status,
      "revoked",
    );
    assert.equal(after.find((row) => row.id === ownerKey.id)?.status, "revoked");
  });
});

test("session key helpers ignore non-owned apps even when external ids match", async (t) => {
  const victimApp = await seedDeveloperAppWithClient({
    name: `Victim ${randomUUID().slice(0, 8)}`,
  });
  const attackerApp = await seedDeveloperAppWithClient({
    name: `Foreign ${randomUUID().slice(0, 8)}`,
  });
  t.after(async () => {
    await cleanupTestApp(attackerApp);
    await cleanupTestApp(victimApp);
  });

  const plantedId = randomUUID();
  await db.insert(appUsers).values({
    id: plantedId,
    clientId: attackerApp.clientId,
    externalUserId: victimApp.userId,
    status: "active",
    role: "user",
    createdAt: new Date().toISOString(),
  });
  const plantedKey = await createAppUserApiKey({
    developerAppId: attackerApp.clientId,
    appUserId: plantedId,
    label: "planted",
  });

  const realAppUserId = randomUUID();
  await db.insert(appUsers).values({
    id: realAppUserId,
    clientId: victimApp.clientId,
    externalUserId: victimApp.userId,
    status: "active",
    role: "user",
    createdAt: new Date().toISOString(),
  });
  const realKey = await createAppUserApiKey({
    developerAppId: victimApp.clientId,
    appUserId: realAppUserId,
    label: "real",
  });

  const listed = await listSessionUserApiKeys(victimApp.userId);
  assert.equal(listed.some((row) => row.id === plantedKey.id), false);
  assert.equal(listed.some((row) => row.id === realKey.id), true);

  const plantedRows = await db
    .select({ status: appUsers.status })
    .from(appUsers)
    .where(and(eq(appUsers.id, plantedId)));
  assert.equal(plantedRows[0]?.status, "active");
});
