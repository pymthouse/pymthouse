import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";

import { test } from "@/test-utils/db-guard";
import {
  cleanupTestApp,
  createTestUser,
  seedDeveloperAppWithClient,
} from "@/test-utils/fixtures";
import {
  restorePlatformDefaultFlag,
  runExclusivePlatformDefaultMutation,
  withTemporaryPlatformDefault,
} from "@/test-utils/platform-default-lock";
import { db } from "@/db/index";
import { developerApps, users } from "@/db/schema";
import {
  ensurePlatformDefaultApp,
  notPlatformDefaultApp,
  resolvePlatformDefaultClientId,
} from "@/lib/platform-default-app";

test("catalog filters exclude the flagged platform default app", async (t) => {
  const app = await seedDeveloperAppWithClient({
    name: `Catalog ${randomUUID().slice(0, 8)}`,
    status: "approved",
  });
  t.after(async () => {
    await cleanupTestApp(app);
  });

  await withTemporaryPlatformDefault(app.clientId, async () => {
    await db
      .update(developerApps)
      .set({
        publishedAt: new Date().toISOString(),
        marketplaceFeatured: 1,
      })
      .where(eq(developerApps.id, app.clientId));

    const visible = await db
      .select({ id: developerApps.id })
      .from(developerApps)
      .where(
        and(eq(developerApps.id, app.clientId), notPlatformDefaultApp()),
      );
    assert.equal(visible.length, 0);
  });
});

test("ensurePlatformDefaultApp is idempotent for an existing flagged app", async (t) => {
  const adminId = await createTestUser({ role: "admin" });
  const app = await seedDeveloperAppWithClient({
    ownerId: adminId,
    name: `Ensure ${randomUUID().slice(0, 8)}`,
  });
  t.after(async () => {
    await cleanupTestApp(app);
  });

  await withTemporaryPlatformDefault(app.clientId, async () => {
    // Force unpublish so ensure repairs marketplace fields.
    await db
      .update(developerApps)
      .set({ publishedAt: new Date().toISOString(), marketplaceFeatured: 1 })
      .where(eq(developerApps.id, app.clientId));

    const first = await ensurePlatformDefaultApp({ ownerId: adminId });
    const second = await ensurePlatformDefaultApp({ ownerId: adminId });
    const concurrent = await Promise.all([
      ensurePlatformDefaultApp({ ownerId: adminId }),
      ensurePlatformDefaultApp({ ownerId: adminId }),
    ]);

    assert.equal(first.created, false);
    assert.equal(first.clientId, app.clientId);
    assert.equal(second.created, false);
    assert.equal(second.clientId, app.clientId);
    assert.ok(concurrent.every((row) => row.clientId === app.clientId));

    const flagged = await db
      .select({
        id: developerApps.id,
        publishedAt: developerApps.publishedAt,
        marketplaceFeatured: developerApps.marketplaceFeatured,
      })
      .from(developerApps)
      .where(eq(developerApps.isPlatformDefault, 1));
    assert.equal(flagged.length, 1);
    assert.equal(flagged[0]?.id, app.clientId);
    assert.equal(flagged[0]?.publishedAt, null);
    assert.equal(flagged[0]?.marketplaceFeatured, 0);
  });
});

test("ensurePlatformDefaultApp promotes configured app to flagged singleton", async (t) => {
  const app = await seedDeveloperAppWithClient({
    name: `Configured ${randomUUID().slice(0, 8)}`,
  });
  const priorEnv = process.env.PYMTHOUSE_DEFAULT_APP_CLIENT_ID;
  t.after(async () => {
    if (priorEnv === undefined) {
      delete process.env.PYMTHOUSE_DEFAULT_APP_CLIENT_ID;
    } else {
      process.env.PYMTHOUSE_DEFAULT_APP_CLIENT_ID = priorEnv;
    }
    await cleanupTestApp(app);
  });

  // Isolate promotion against whatever is currently flagged.
  await withTemporaryPlatformDefault(app.clientId, async () => {
    // Demote our fixture so resolve must promote via env.
    await db
      .update(developerApps)
      .set({ isPlatformDefault: 0, publishedAt: new Date().toISOString() })
      .where(eq(developerApps.id, app.clientId));

    process.env.PYMTHOUSE_DEFAULT_APP_CLIENT_ID = app.clientId;
    // Promotion is write-side (ensure), not resolve.
    await ensurePlatformDefaultApp();
    const resolved = await resolvePlatformDefaultClientId();
    assert.equal(resolved, app.clientId);

    const flagged = await db
      .select({
        id: developerApps.id,
        isPlatformDefault: developerApps.isPlatformDefault,
        publishedAt: developerApps.publishedAt,
      })
      .from(developerApps)
      .where(eq(developerApps.id, app.clientId))
      .limit(1);
    assert.equal(flagged[0]?.isPlatformDefault, 1);
    assert.equal(flagged[0]?.publishedAt, null);
  });
});

test("ensurePlatformDefaultApp creates once when no default exists", async (t) => {
  await runExclusivePlatformDefaultMutation(async () => {
    const prior = await db
      .select({ id: developerApps.id })
      .from(developerApps)
      .where(eq(developerApps.isPlatformDefault, 1));
    await db
      .update(developerApps)
      .set({ isPlatformDefault: 0 })
      .where(eq(developerApps.isPlatformDefault, 1));

    const adminId = await createTestUser({ role: "admin" });
    let createdId: string | null = null;

    t.after(async () => {
      await runExclusivePlatformDefaultMutation(async () => {
        if (createdId) {
          const rows = await db
            .select({
              id: developerApps.id,
              oidcClientId: developerApps.oidcClientId,
              ownerId: developerApps.ownerId,
            })
            .from(developerApps)
            .where(eq(developerApps.id, createdId!))
            .limit(1);
          const row = rows[0];
          if (row?.ownerId && row.oidcClientId) {
            await cleanupTestApp({
              clientId: row.id,
              oidcClientRowId: row.oidcClientId,
              userId: row.ownerId,
              clientSecret: "unused",
            });
          }
        } else {
          await db.delete(users).where(eq(users.id, adminId));
        }
        await db
          .update(developerApps)
          .set({ isPlatformDefault: 0 })
          .where(eq(developerApps.isPlatformDefault, 1));
        await restorePlatformDefaultFlag(prior[0]?.id);
      });
    });

    delete process.env.PYMTHOUSE_DEFAULT_APP_CLIENT_ID;
    const first = await ensurePlatformDefaultApp({ ownerId: adminId });
    createdId = first.created ? first.clientId : null;
    const second = await ensurePlatformDefaultApp({ ownerId: adminId });

    assert.equal(second.clientId, first.clientId);
    assert.equal(second.created, false);
    if (first.created) {
      assert.equal(createdId, first.clientId);
    }

    const flagged = await db
      .select({ id: developerApps.id, publishedAt: developerApps.publishedAt })
      .from(developerApps)
      .where(eq(developerApps.isPlatformDefault, 1));
    assert.equal(flagged.length, 1);
    assert.equal(flagged[0]?.id, first.clientId);
    assert.equal(flagged[0]?.publishedAt, null);
  });
});
