/**
 * Audit platform-controlled billing fields before locking them to admins.
 *
 * `application_fee_bps` (PymtHouse's share of Connect payments) and
 * `end_user_cap` (the cost-rail spend guard) are currently editable by the app
 * owner — the party each one constrains. See docs/adr-owner-vs-app-billing.md.
 *
 * Locking them is a behaviour change for any Builder who already moved them, so
 * this reports the current state first. Read-only: it never writes.
 *
 * Usage:
 *   npx tsx scripts/audit-platform-billing-fields.ts
 *   npx tsx scripts/audit-platform-billing-fields.ts --json
 */
import "./load-env-first";
import { eq } from "drizzle-orm";

import { closeDb, db } from "../src/db/index";
import { appBillingConfig, developerApps, users } from "../src/db/schema";

/** Defaults from the schema; anything else was changed deliberately. */
const DEFAULT_APPLICATION_FEE_BPS = 0;
const DEFAULT_END_USER_CAP = 25;

type AuditRow = {
  appId: string;
  appName: string;
  ownerId: string;
  ownerEmail: string | null;
  billingMode: string;
  applicationFeeBps: number;
  endUserCap: number;
  connectedAccountId: string | null;
  /** Connect volume earns PymtHouse nothing at 0 bps. */
  zeroFeeWithConnect: boolean;
  raisedCap: boolean;
};

async function main(): Promise<void> {
  const asJson = process.argv.includes("--json");

  const rows = await db
    .select({
      appId: developerApps.id,
      appName: developerApps.name,
      ownerId: developerApps.ownerId,
      ownerEmail: users.email,
      billingMode: appBillingConfig.billingMode,
      applicationFeeBps: appBillingConfig.applicationFeeBps,
      endUserCap: appBillingConfig.endUserCap,
      connectedAccountId: appBillingConfig.stripeConnectedAccountId,
      chargesEnabled: appBillingConfig.stripeChargesEnabled,
    })
    .from(appBillingConfig)
    .innerJoin(developerApps, eq(appBillingConfig.clientId, developerApps.id))
    .leftJoin(users, eq(developerApps.ownerId, users.id));

  const audited: AuditRow[] = rows.map((row) => ({
    appId: row.appId,
    appName: row.appName,
    ownerId: row.ownerId,
    ownerEmail: row.ownerEmail,
    billingMode: row.billingMode,
    applicationFeeBps: row.applicationFeeBps,
    endUserCap: row.endUserCap,
    connectedAccountId: row.connectedAccountId,
    zeroFeeWithConnect:
      row.applicationFeeBps === 0 &&
      Boolean(row.chargesEnabled) &&
      row.billingMode === "merchant",
    raisedCap: row.endUserCap > DEFAULT_END_USER_CAP,
  }));

  if (asJson) {
    console.log(JSON.stringify(audited, null, 2));
    return;
  }

  const nonDefaultFee = audited.filter(
    (row) => row.applicationFeeBps !== DEFAULT_APPLICATION_FEE_BPS,
  );
  const raisedCaps = audited.filter((row) => row.raisedCap);
  const revenueLeak = audited.filter((row) => row.zeroFeeWithConnect);

  console.log(`Apps with billing config: ${audited.length}`);
  console.log(
    `  application_fee_bps != ${DEFAULT_APPLICATION_FEE_BPS}: ${nonDefaultFee.length}`,
  );
  console.log(`  end_user_cap > ${DEFAULT_END_USER_CAP}: ${raisedCaps.length}`);
  console.log(
    `  0 bps WITH Connect charges enabled (earning nothing): ${revenueLeak.length}`,
  );

  if (revenueLeak.length > 0) {
    console.log("\nConnect-enabled apps taking a 0 bps platform fee:");
    for (const row of revenueLeak) {
      console.log(
        `  ${row.appId}  ${row.appName}  owner=${row.ownerEmail ?? row.ownerId}  acct=${row.connectedAccountId ?? "-"}`,
      );
    }
  }

  if (raisedCaps.length > 0) {
    console.log("\nApps whose owner raised their own end-user cap:");
    for (const row of raisedCaps) {
      console.log(
        `  ${row.appId}  ${row.appName}  cap=${row.endUserCap}  owner=${row.ownerEmail ?? row.ownerId}`,
      );
    }
  }

  if (nonDefaultFee.length === 0 && raisedCaps.length === 0) {
    console.log("\nNo app has moved either field — locking them changes nothing.");
  }
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => closeDb());
