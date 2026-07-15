/**
 * One-shot: report and optionally drop legacy usage ledger tables.
 *
 *   npx tsx scripts/check-legacy-usage-tables.ts
 *   npx tsx scripts/check-legacy-usage-tables.ts --drop
 */
import "./load-env-first";
import postgres from "postgres";

async function main() {
  const databaseUrl = process.env.DATABASE_URL?.trim();
  if (!databaseUrl) throw new Error("DATABASE_URL is required.");

  const drop = process.argv.includes("--drop");
  const sql = postgres(databaseUrl, { max: 1 });
  try {
    const host = databaseUrl.match(/@([^/]+)/)?.[1] ?? "?";
    const [tables] = await sql<{
      usage_records: string | null;
      usage_billing_events: string | null;
    }[]>`
      SELECT to_regclass('public.usage_records')::text AS usage_records,
             to_regclass('public.usage_billing_events')::text AS usage_billing_events
    `;
    const [counts] = await sql<{ matching: number }[]>`
      SELECT COUNT(*)::int AS matching
      FROM developer_apps
      WHERE name ~ '^Test App [0-9a-f]{8}$'
    `;
    console.log({
      host,
      usage_records: tables.usage_records,
      usage_billing_events: tables.usage_billing_events,
      matching_test_apps: counts.matching,
    });

    if (!drop) {
      console.log("Re-run with --drop to DROP TABLE IF EXISTS both legacy tables.");
      return;
    }

    await sql`DROP TABLE IF EXISTS usage_billing_events`;
    await sql`DROP TABLE IF EXISTS usage_records`;
    const [after] = await sql<{
      usage_records: string | null;
      usage_billing_events: string | null;
    }[]>`
      SELECT to_regclass('public.usage_records')::text AS usage_records,
             to_regclass('public.usage_billing_events')::text AS usage_billing_events
    `;
    console.log("Dropped. Now:", after);
  } finally {
    await sql.end({ timeout: 5 });
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
