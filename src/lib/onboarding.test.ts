import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";

import { test } from "@/test-utils/db-guard";
import {
  cleanupTestApp,
  createTestUser,
  seedDeveloperAppWithClient,
  type SeededDeveloperApp,
} from "@/test-utils/fixtures";
import { withTemporaryPlatformDefault } from "@/test-utils/platform-default-lock";
import { db } from "@/db/index";
import { appUsers, providerAdmins, users } from "@/db/schema";
import {
  markOnboardingComplete,
  mintDefaultAppNetworkKey,
} from "@/lib/onboarding";
import { listUserAccessibleApps } from "@/lib/user-apps";

async function seedTemporaryDefault(
  t: { after: (fn: () => Promise<void>) => void },
): Promise<SeededDeveloperApp> {
  const app = await seedDeveloperAppWithClient({
    name: `Default ${randomUUID().slice(0, 8)}`,
  });
  t.after(async () => {
    await cleanupTestApp(app);
  });
  return app;
}

async function cleanupExternalUser(externalUserId: string): Promise<void> {
  await db.execute(sql`
    DELETE FROM api_keys
    WHERE app_user_id IN (
      SELECT id FROM app_users WHERE external_user_id = ${externalUserId}
    )
  `);
  await db.delete(appUsers).where(eq(appUsers.externalUserId, externalUserId));
  await db.delete(users).where(eq(users.id, externalUserId));
}

test("listUserAccessibleApps excludes platform default apps", async (t) => {
  const app = await seedTemporaryDefault(t);

  await withTemporaryPlatformDefault(app.clientId, async () => {
    const listed = await listUserAccessibleApps(app.userId);
    assert.equal(
      listed.some((row) => row.clientId === app.clientId),
      false,
    );
  });
});

test("mintDefaultAppNetworkKey creates app_users not provider_admins", async (t) => {
  const app = await seedTemporaryDefault(t);

  const explorerId = await createTestUser({ role: "developer" });
  t.after(async () => {
    await cleanupExternalUser(explorerId);
  });

  await withTemporaryPlatformDefault(app.clientId, async () => {
    const result = await mintDefaultAppNetworkKey({
      userId: explorerId,
      email: `${explorerId}@example.test`,
    });

    assert.equal(result.clientId, app.clientId);
    assert.ok(result.apiKey.startsWith(`${app.clientId}_`));

    const membership = await db
      .select()
      .from(appUsers)
      .where(eq(appUsers.externalUserId, explorerId));
    assert.equal(membership.length, 1);
    assert.equal(membership[0]?.clientId, app.clientId);

    const adminRows = await db
      .select()
      .from(providerAdmins)
      .where(eq(providerAdmins.userId, explorerId));
    assert.equal(adminRows.length, 0);

    const explorer = await db
      .select({
        persona: users.persona,
        onboardingCompletedAt: users.onboardingCompletedAt,
      })
      .from(users)
      .where(eq(users.id, explorerId))
      .limit(1);
    assert.equal(explorer[0]?.persona, "explorer");
    assert.ok(explorer[0]?.onboardingCompletedAt);
  });
});

test("mintDefaultAppNetworkKey keeps builder persona", async (t) => {
  const app = await seedTemporaryDefault(t);

  const builderId = await createTestUser({ role: "developer" });
  t.after(async () => {
    await cleanupExternalUser(builderId);
  });

  await markOnboardingComplete(builderId, "builder");

  await withTemporaryPlatformDefault(app.clientId, async () => {
    const result = await mintDefaultAppNetworkKey({
      userId: builderId,
      email: `${builderId}@example.test`,
    });

    assert.equal(result.clientId, app.clientId);
    assert.ok(result.apiKey);

    const membership = await db
      .select()
      .from(appUsers)
      .where(eq(appUsers.externalUserId, builderId));
    assert.equal(membership.length, 1);
    assert.equal(membership[0]?.clientId, app.clientId);

    const builder = await db
      .select({
        persona: users.persona,
        onboardingCompletedAt: users.onboardingCompletedAt,
      })
      .from(users)
      .where(eq(users.id, builderId))
      .limit(1);
    assert.equal(builder[0]?.persona, "builder");
    assert.ok(builder[0]?.onboardingCompletedAt);
  });
});

test("markOnboardingComplete sets builder persona", async (t) => {
  const userId = await createTestUser({ role: "developer" });
  t.after(async () => {
    await db.delete(users).where(eq(users.id, userId));
  });

  await markOnboardingComplete(userId, "builder");
  const rows = await db
    .select({
      persona: users.persona,
      onboardingCompletedAt: users.onboardingCompletedAt,
    })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  assert.equal(rows[0]?.persona, "builder");
  assert.ok(rows[0]?.onboardingCompletedAt);
});
