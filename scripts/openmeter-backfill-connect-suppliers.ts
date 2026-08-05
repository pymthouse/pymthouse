/**
 * Backfill Connect supplier identity onto app_billing_config + OM profiles.
 *
 *   npx tsx scripts/openmeter-backfill-connect-suppliers.ts --dry-run
 *   npx tsx scripts/openmeter-backfill-connect-suppliers.ts --apply
 */
import "./load-env-first";
import { closeDb, db } from "../src/db/index";
import { appBillingConfig } from "../src/db/schema";
import { syncTenantSupplierFromConnect } from "../src/lib/openmeter/supplier-sync";
import { isNotNull } from "drizzle-orm";

async function main() {
  const apply = process.argv.includes("--apply");
  const dryRun = !apply;

  const rows = await db
    .select({
      clientId: appBillingConfig.clientId,
      accountId: appBillingConfig.stripeConnectedAccountId,
    })
    .from(appBillingConfig)
    .where(isNotNull(appBillingConfig.stripeConnectedAccountId));

  console.log(
    `${dryRun ? "DRY-RUN" : "APPLY"}: ${rows.length} app(s) with connected accounts`,
  );

  for (const row of rows) {
    const accountId = row.accountId?.trim();
    if (!accountId) continue;
    if (dryRun) {
      console.log(`would sync ${row.clientId} ← ${accountId}`);
      continue;
    }
    try {
      const result = await syncTenantSupplierFromConnect({
        clientId: row.clientId,
        accountId,
      });
      console.log(
        `${row.clientId}: ${result.status} gaps=${result.gaps.join(",") || "none"}`,
      );
    } catch (err) {
      console.error(
        `${row.clientId}: FAILED`,
        err instanceof Error ? err.message : String(err),
      );
    }
  }
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await closeDb();
  });
