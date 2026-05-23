/**
 * Apply Drizzle SQL migrations to PostgreSQL (DATABASE_URL).
 *
 * Drizzle applies only migrations whose journal `when` (folderMillis) is **strictly
 * greater** than `drizzle.__drizzle_migrations.created_at` on the latest row (ORDER BY
 * created_at DESC LIMIT 1). Older journal entries are skipped. If that latest
 * `created_at` is already above a migration's `when` (restored DB, branch mismatch,
 * manual edits), that migration never runs—add a new SQL migration with a higher
 * `when` (e.g. 0018_discovery_allowed_capabilities_repair) or repair the table.
 */
import "./load-env-first";
import path from "path";
import { existsSync } from "fs";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import * as schema from "../src/db/schema";

/**
 * Resolve the drizzle migrations folder robustly across environments
 * (local dev, Vercel build, tsx CJS/ESM transforms).
 */
function findMigrationsFolder(): string {
  // 1. npm scripts always set cwd to the project root
  const fromCwd = path.resolve(process.cwd(), "drizzle");
  if (existsSync(path.join(fromCwd, "meta", "_journal.json"))) return fromCwd;

  // 2. Relative to this script file (works when __dirname is available)
  if (typeof __dirname !== "undefined") {
    const fromDir = path.resolve(__dirname, "..", "drizzle");
    if (existsSync(path.join(fromDir, "meta", "_journal.json"))) return fromDir;
  }

  throw new Error(
    `Cannot locate drizzle/meta/_journal.json from cwd=${process.cwd()}`
  );
}

const { signerConfig } = schema;

async function seedDefaultSigner(dbUrl: string) {
  const client = postgres(dbUrl, { max: 1 });
  const db = drizzle(client, { schema });
  const now = new Date().toISOString();
  await db
    .insert(signerConfig)
    .values({
      id: "default",
      name: "pymthouse signer",
      network: "arbitrum-one-mainnet",
      ethRpcUrl: "https://arb1.arbitrum.io/rpc",
      signerPort: 8080,
      status: "stopped",
      defaultCutPercent: 15.0,
      billingMode: "delegated",
      createdAt: now,
    })
    .onConflictDoNothing({ target: signerConfig.id });
  await client.end({ timeout: 5 });
}

async function main() {
  const databaseUrl = process.env.DATABASE_URL?.trim();
  if (!databaseUrl) {
    console.error("[db:migrate] DATABASE_URL is not set.");
    process.exit(1);
  }

  const migrationClient = postgres(databaseUrl, { max: 1 });
  const migrationsFolder = findMigrationsFolder();
  console.log(`[db:migrate] Using migrations from: ${migrationsFolder}`);
  await migrate(drizzle(migrationClient, { schema }), {
    migrationsFolder,
  });
  await migrationClient.end({ timeout: 5 });

  await seedDefaultSigner(databaseUrl);

  console.log("[db:migrate] PostgreSQL migrations applied.");
}

main().catch((err) => {
  console.error("[db:migrate] Error:", err);
  process.exit(1);
});
