/**
 * Move existing OM billing profiles onto anchored daily collection.
 *
 * Profiles created before this inherited OM's `subscription` alignment default,
 * so on a P1M plan gathering lines were only collected at cycle close. Run this
 * before the $2 minimum-ceiling migration so collection is already tightened
 * when ceilings move.
 *
 *   npx tsx scripts/openmeter-backfill-collection-alignment.ts --dry-run
 *   npx tsx scripts/openmeter-backfill-collection-alignment.ts --apply
 */
import "./load-env-first";
import { closeDb, db } from "../src/db/index";
import { appBillingConfig } from "../src/db/schema";
import { syncCollectionAlignmentToOpenMeterProfile } from "../src/lib/openmeter/billing-profiles";

async function main() {
  const apply = process.argv.includes("--apply");
  const dryRun = !apply;

  const rows = await db
    .select({
      clientId: appBillingConfig.clientId,
      profileId: appBillingConfig.openmeterBillingProfileId,
      merchantProfileId: appBillingConfig.openmeterMerchantBillingProfileId,
    })
    .from(appBillingConfig);

  const rowTargets = rows.flatMap((row) =>
    [row.profileId, row.merchantProfileId]
      .map((id) => id?.trim())
      .filter((id): id is string => Boolean(id))
      .map((profileId) => ({ clientId: row.clientId, profileId })),
  );

  // The shared merchant Custom Invoicing profile lives in an env var, not in
  // app_billing_config, so the row scan alone never reaches it.
  const envMerchantProfileId =
    process.env.OPENMETER_MERCHANT_BILLING_PROFILE_ID?.trim();
  if (envMerchantProfileId) {
    rowTargets.push({
      clientId: "(shared merchant profile)",
      profileId: envMerchantProfileId,
    });
  }

  const seen = new Set<string>();
  const targets = rowTargets.filter((target) => {
    if (seen.has(target.profileId)) return false;
    seen.add(target.profileId);
    return true;
  });

  console.log(
    `${dryRun ? "DRY-RUN" : "APPLY"}: ${targets.length} profile(s) across ${rows.length} app(s)`,
  );

  let failures = 0;
  let skipped = 0;
  for (const target of targets) {
    if (dryRun) {
      console.log(`would anchor ${target.profileId} (${target.clientId})`);
      continue;
    }
    try {
      await syncCollectionAlignmentToOpenMeterProfile({
        profileId: target.profileId,
      });
      console.log(`${target.clientId}: anchored ${target.profileId}`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // Rows can reference profiles that were since deleted in Konnect;
      // nothing to anchor there.
      if (/is deleted/.test(message)) {
        skipped += 1;
        console.log(`${target.clientId}: skipped ${target.profileId} (deleted)`);
        continue;
      }
      failures += 1;
      console.error(`${target.clientId}: FAILED ${target.profileId}`, message);
    }
  }
  if (skipped > 0) {
    console.log(`${skipped} deleted profile(s) skipped`);
  }
  if (failures > 0) {
    throw new Error(`collection backfill failed for ${failures} profile(s)`);
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
