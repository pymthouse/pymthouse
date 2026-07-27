import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq, sql } from "drizzle-orm";

import { db } from "@/db/index";
import { developerApps } from "@/db/schema";

const LOCK_DIR = join(tmpdir(), "pymthouse-platform-default-lock");

/**
 * Cross-process exclusive lock. Node's test runner may isolate files in separate
 * processes, so an in-process promise chain is not enough for the singleton flag.
 */
async function withFileLock<T>(fn: () => Promise<T>): Promise<T> {
  for (;;) {
    try {
      mkdirSync(LOCK_DIR);
      break;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== "EEXIST") {
        throw err;
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }

  try {
    return await fn();
  } finally {
    try {
      rmSync(LOCK_DIR, { recursive: true, force: true });
    } catch {
      // Best-effort unlock; next waiter retries.
    }
  }
}

/**
 * Serialize mutations of the singleton `is_platform_default` flag across tests
 * (same process and cross-process).
 */
export function runExclusivePlatformDefaultMutation<T>(
  fn: () => Promise<T>,
): Promise<T> {
  return withFileLock(fn);
}

async function clearPlatformDefaultFlags(): Promise<void> {
  await db
    .update(developerApps)
    .set({ isPlatformDefault: 0 })
    .where(eq(developerApps.isPlatformDefault, 1));
}

/**
 * Restore a previously flagged row, or re-select the newest admin-owned internal
 * candidate so tests never permanently clear the singleton.
 */
export async function restorePlatformDefaultFlag(
  priorId: string | undefined,
): Promise<void> {
  await clearPlatformDefaultFlags();
  if (priorId) {
    await db
      .update(developerApps)
      .set({ isPlatformDefault: 1 })
      .where(eq(developerApps.id, priorId));
    return;
  }

  await db.execute(sql`
    UPDATE developer_apps
    SET is_platform_default = 1,
        published_at = NULL,
        marketplace_featured = 0
    WHERE id = (
      SELECT d.id
      FROM developer_apps d
      INNER JOIN users u ON u.id = d.owner_id
      WHERE u.role = 'admin'
        AND d.name IN ('PymtHouse App', 'PymtHouse Network')
      ORDER BY
        CASE d.name
          WHEN 'PymtHouse App' THEN 0
          WHEN 'PymtHouse Network' THEN 1
          ELSE 2
        END,
        d.created_at DESC
      LIMIT 1
    )
  `);
}

/**
 * Temporarily make `appId` the unique platform-default app, then restore the
 * previously flagged row (at most one). Serialized across concurrent tests.
 */
export async function withTemporaryPlatformDefault(
  appId: string,
  run: () => Promise<void>,
): Promise<void> {
  await runExclusivePlatformDefaultMutation(async () => {
    const prior = await db
      .select({ id: developerApps.id })
      .from(developerApps)
      .where(eq(developerApps.isPlatformDefault, 1));

    await clearPlatformDefaultFlags();
    await db
      .update(developerApps)
      .set({ isPlatformDefault: 1 })
      .where(eq(developerApps.id, appId));

    try {
      await run();
    } finally {
      await restorePlatformDefaultFlag(prior[0]?.id);
    }
  });
}
