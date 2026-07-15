/**
 * Remove leaked test-fixture developer apps from a database.
 *
 * Matches only names like `Test App d6595404` (exactly "Test App " + 8 hex
 * chars). Does not touch apps named plain "Test App" or other real apps.
 *
 * Also removes the fixture `user-test-*` owner rows (and any `app-user-*`
 * users that belonged only to those apps) after the apps are deleted.
 *
 * Usage:
 *   npx tsx scripts/cleanup-fixture-test-apps.ts --dry-run
 *   npx tsx scripts/cleanup-fixture-test-apps.ts --execute
 */

import "./load-env-first";
import { eq, inArray, sql } from "drizzle-orm";

import { closeDb, db } from "../src/db/index";
import { appUsers, developerApps, users } from "../src/db/schema";
import { deleteDeveloperAppAndRelatedData } from "../src/lib/delete-developer-app";

/** Same pattern as seedDeveloperAppWithClient: `Test App ${uuid.slice(0, 8)}`. */
const FIXTURE_APP_NAME_RE = /^Test App [0-9a-f]{8}$/;

function hasFlag(flag: string): boolean {
  return process.argv.slice(2).includes(flag);
}

async function main() {
  const databaseUrl = process.env.DATABASE_URL?.trim();
  if (!databaseUrl) {
    throw new Error("DATABASE_URL is required.");
  }

  const execute = hasFlag("--execute");
  const dryRun = hasFlag("--dry-run") || !execute;

  const allApps = await db
    .select({
      id: developerApps.id,
      name: developerApps.name,
      ownerId: developerApps.ownerId,
      oidcClientId: developerApps.oidcClientId,
      createdAt: developerApps.createdAt,
    })
    .from(developerApps)
    .orderBy(developerApps.createdAt);

  const targets = allApps.filter((app) => FIXTURE_APP_NAME_RE.test(app.name));

  if (targets.length === 0) {
    console.log("No developer apps match /^Test App [0-9a-f]{8}$/.");
    return;
  }

  const targetIds = targets.map((app) => app.id);
  const ownerIds = [...new Set(targets.map((app) => app.ownerId))];

  const appUserRows = await db
    .select({ id: appUsers.id, clientId: appUsers.clientId })
    .from(appUsers)
    .where(inArray(appUsers.clientId, targetIds));
  const appUserIds = appUserRows.map((row) => row.id);

  console.log(
    `${dryRun ? "[dry-run]" : "[execute]"} ${targets.length} fixture app(s):`,
  );
  for (const app of targets) {
    console.log(`  - ${app.name}  id=${app.id}  owner=${app.ownerId}  created=${app.createdAt}`);
  }
  console.log(`  owners to remove after apps: ${ownerIds.length}`);
  console.log(`  app_users under those apps: ${appUserIds.length}`);

  if (dryRun) {
    console.log("Re-run with --execute to delete these apps and fixture users.");
    return;
  }

  let deletedApps = 0;
  for (const app of targets) {
    await deleteDeveloperAppAndRelatedData(app.id, app.oidcClientId);
    deletedApps += 1;
    console.log(`  deleted app ${app.name} (${app.id})`);
  }

  // Fixture createAppUser() inserts matching users rows with the same id.
  if (appUserIds.length > 0) {
    const removedAppUsers = await db
      .delete(users)
      .where(inArray(users.id, appUserIds))
      .returning({ id: users.id });
    console.log(`  deleted ${removedAppUsers.length} app-user fixture user(s)`);
  }

  // Only remove owners that look like test fixtures and no longer own any app.
  const fixtureOwners = ownerIds.filter((id) => id.startsWith("user-test-"));
  let deletedOwners = 0;
  for (const ownerId of fixtureOwners) {
    const remaining = await db
      .select({ id: developerApps.id })
      .from(developerApps)
      .where(eq(developerApps.ownerId, ownerId))
      .limit(1);
    if (remaining.length > 0) {
      console.log(`  skip owner ${ownerId}: still owns other apps`);
      continue;
    }
    await db.delete(users).where(eq(users.id, ownerId));
    deletedOwners += 1;
  }

  const leftover = await db.execute<{ count: string }>(
    sql`SELECT COUNT(*)::text AS count FROM developer_apps WHERE name ~ '^Test App [0-9a-f]{8}$'`,
  );
  console.log(
    `[execute] Deleted ${deletedApps} app(s) and ${deletedOwners} fixture owner(s). ` +
      `Matching apps remaining: ${leftover[0]?.count ?? "?"}.`,
  );
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await closeDb();
  });
