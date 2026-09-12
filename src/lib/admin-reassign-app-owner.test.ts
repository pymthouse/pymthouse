import assert from "node:assert/strict";
import { eq } from "drizzle-orm";

import { db } from "@/db/index";
import { developerApps, providerAdmins } from "@/db/schema";
import { reassignAppOwner } from "@/lib/admin-reassign-app-owner";
import { ensureProviderAdminMembership } from "@/lib/provider-apps";
import { test } from "@/test-utils/db-guard";
import {
  cleanupTestApp,
  createTestUser,
  deleteTestUser,
  seedDeveloperAppWithClient,
} from "@/test-utils/fixtures";

test("reassignAppOwner moves owner_id when the current owner has no credits", async (t) => {
  const nextOwner = await createTestUser();
  const app = await seedDeveloperAppWithClient({
    name: `Reassign ${nextOwner.slice(0, 8)}`,
  });
  t.after(async () => {
    await cleanupTestApp(app);
    await deleteTestUser(nextOwner);
  });
  await ensureProviderAdminMembership(app.userId, app.clientId);

  const result = await reassignAppOwner({
    appId: app.clientId,
    newOwnerUserId: nextOwner,
  });
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.ownerId, nextOwner);
  }

  const rows = await db
    .select({ ownerId: developerApps.ownerId })
    .from(developerApps)
    .where(eq(developerApps.id, app.clientId))
    .limit(1);
  assert.equal(rows[0]?.ownerId, nextOwner);

  const memberships = await db
    .select({ userId: providerAdmins.userId })
    .from(providerAdmins)
    .where(eq(providerAdmins.clientId, app.clientId));
  const memberIds = memberships.map((row) => row.userId);
  assert.equal(memberIds.includes(app.userId), false);
  assert.equal(memberIds.includes(nextOwner), true);
});

test("reassignAppOwner refuses an unknown user", async (t) => {
  const app = await seedDeveloperAppWithClient({
    name: `Missing owner ${Date.now()}`,
  });
  t.after(async () => {
    await cleanupTestApp(app);
  });

  const result = await reassignAppOwner({
    appId: app.clientId,
    newOwnerUserId: "00000000-0000-4000-8000-000000000000",
  });
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.status, 404);
  }
});
