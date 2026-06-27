/**
 * Hard-cutover helper: revoke every active API key.
 *
 * Usage:
 *   npx tsx scripts/api-keys-hard-cutover.ts --dry-run
 *   npx tsx scripts/api-keys-hard-cutover.ts --execute
 */

import "./load-env-first";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { eq } from "drizzle-orm";
import * as schema from "../src/db/schema";
import { apiKeys } from "../src/db/schema";

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

  const client = postgres(databaseUrl, { max: 1 });
  const db = drizzle(client, { schema });

  try {
    const activeRows = await db
      .select({ id: apiKeys.id })
      .from(apiKeys)
      .where(eq(apiKeys.status, "active"));

    if (dryRun) {
      console.log(
        `[dry-run] ${activeRows.length} active API key(s) would be revoked.`,
      );
      console.log("Re-run with --execute to apply the hard cutover.");
      return;
    }

    const now = new Date().toISOString();
    const revoked = await db
      .update(apiKeys)
      .set({
        status: "revoked",
        revokedAt: now,
      })
      .where(eq(apiKeys.status, "active"))
      .returning({ id: apiKeys.id });

    console.log(
      `[execute] Revoked ${revoked.length} API key(s). Users must mint new keys.`,
    );
  } finally {
    await client.end({ timeout: 5 });
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
