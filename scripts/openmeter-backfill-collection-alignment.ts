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

  const targets = rows.flatMap((row) =>
    [row.profileId, row.merchantProfileId]
      .map((id) => id?.trim())
      .filter((id): id is string => Boolean(id))
      .map((profileId) => ({ clientId: row.clientId, profileId })),
  );

  console.log(
    `${dryRun ? "DRY-RUN" : "APPLY"}: ${targets.length} profile(s) across ${rows.length} app(s)`,
  );

  let failures = 0;
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
      failures += 1;
      console.error(
        `${target.clientId}: FAILED ${target.profileId}`,
        err instanceof Error ? err.message : String(err),
      );
    }
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
