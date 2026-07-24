/**
 * Ensure OpenMeter/Konnect customer (+ optional Starter subscription) for app users.
 *
 * Use when ingest reports "no customer found for event subject" but pymthouse already
 * minted signer tokens, or to backfill customers after billing-profile fixes.
 *
 * Usage:
 *   npx tsx scripts/openmeter-ensure-customer.ts --customer-key 'app_xxx:external-user-id'
 *   npx tsx scripts/openmeter-ensure-customer.ts --client-id app_xxx --external-user-id uuid
 *   npx tsx scripts/openmeter-ensure-customer.ts --client-id app_xxx --all-users
 *   npx tsx scripts/openmeter-ensure-customer.ts --client-id app_xxx --all-users --customer-only
 */
import "./load-env-first";
import { eq } from "drizzle-orm";
import { closeDb, db } from "../src/db/index";
import { appUsers } from "../src/db/schema";
import {
  ensureAppUserKonnectCustomer,
  provisionAppUserBilling,
} from "../src/lib/billing/provision-app-user";
import { parseOpenMeterCustomerKey } from "../src/lib/openmeter/customer-key";
import { getHostedAdminClient, isHostedAdminClientAvailable } from "../src/lib/openmeter/admin-client";
import { ensureStarterSubscriptionForAppUser } from "../src/lib/openmeter/starter-subscription";
import { ensureTrialAllowanceForAppUser } from "../src/lib/openmeter/trial-allowance";
import { getTrialCreditBalance } from "../src/lib/openmeter/entitlements";

type Args = {
  customerKey?: string;
  clientId?: string;
  externalUserId?: string;
  allUsers: boolean;
  customerOnly: boolean;
  provisionDb: boolean;
};

function parseArgs(argv: string[]): Args {
  const args: Args = {
    allUsers: false,
    customerOnly: false,
    provisionDb: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === "--customer-key") {
      args.customerKey = argv[++i]?.trim();
      continue;
    }
    if (token === "--client-id") {
      args.clientId = argv[++i]?.trim();
      continue;
    }
    if (token === "--external-user-id") {
      args.externalUserId = argv[++i]?.trim();
      continue;
    }
    if (token === "--all-users") {
      args.allUsers = true;
      continue;
    }
    if (token === "--customer-only") {
      args.customerOnly = true;
      continue;
    }
    if (token === "--provision-db") {
      args.provisionDb = true;
      continue;
    }
    throw new Error(`Unknown argument: ${token}`);
  }

  return args;
}

function usage(): string {
  return [
    "openmeter-ensure-customer",
    "",
    "  --customer-key <app_id:external_user_id>",
    "  --client-id <app_id> --external-user-id <id>",
    "  --client-id <app_id> --all-users",
    "",
    "Options:",
    "  --customer-only   Upsert Konnect customer + subject keys only (no Starter subscription / credits)",
    "  --provision-db    Run full provisionAppUserBilling (DB rows + subscription + credit grant)",
  ].join("\n");
}

async function resolveTargets(args: Args): Promise<Array<{ clientId: string; externalUserId: string }>> {
  if (args.customerKey) {
    const parsed = parseOpenMeterCustomerKey(args.customerKey);
    if (!parsed) {
      throw new Error(`Invalid --customer-key: ${args.customerKey}`);
    }
    return [parsed];
  }

  if (!args.clientId) {
    throw new Error(`Missing --client-id or --customer-key\n\n${usage()}`);
  }

  if (args.allUsers) {
    const rows = await db
      .select({ externalUserId: appUsers.externalUserId })
      .from(appUsers)
      .where(eq(appUsers.clientId, args.clientId));
    if (rows.length === 0) {
      throw new Error(`No app_users rows for client ${args.clientId}`);
    }
    return rows.map((row) => ({
      clientId: args.clientId!,
      externalUserId: row.externalUserId,
    }));
  }

  if (!args.externalUserId) {
    throw new Error(`Missing --external-user-id\n\n${usage()}`);
  }

  return [{ clientId: args.clientId, externalUserId: args.externalUserId }];
}

async function ensureOne(input: {
  clientId: string;
  externalUserId: string;
  customerOnly: boolean;
  provisionDb: boolean;
}) {
  const label = `${input.clientId}:${input.externalUserId}`;
  if (input.provisionDb) {
    const result = await provisionAppUserBilling({
      clientId: input.clientId,
      externalUserId: input.externalUserId,
    });
    console.log(
      `[ok] ${label} provisioned appUser=${result.appUserId} starterReady=${result.starterSubscriptionReady}`,
    );
    return;
  }

  if (input.customerOnly) {
    const customer = await ensureAppUserKonnectCustomer({
      clientId: input.clientId,
      externalUserId: input.externalUserId,
    });
    console.log(`[ok] ${label} customer id=${customer.id} key=${customer.key}`);
    return;
  }

  const customer = await ensureAppUserKonnectCustomer({
    clientId: input.clientId,
    externalUserId: input.externalUserId,
  });
  const sub = await ensureStarterSubscriptionForAppUser({
    clientId: input.clientId,
    externalUserId: input.externalUserId,
  });
  await ensureTrialAllowanceForAppUser({
    clientId: input.clientId,
    externalUserId: input.externalUserId,
  });
  const allowance = await getTrialCreditBalance({
    clientId: input.clientId,
    externalUserId: input.externalUserId,
  });
  console.log(
    `[ok] ${label} customer id=${customer.id} subscription=${sub.openmeterSubscriptionId ?? "none"} created=${sub.created} hasAccess=${allowance?.hasAccess ?? "n/a"} balanceUsdMicros=${allowance?.balanceUsdMicros ?? "n/a"}`,
  );
}

async function main() {
  if (!isHostedAdminClientAvailable()) {
    console.error("[openmeter-ensure-customer] OPENMETER_URL is not configured.");
    process.exit(1);
  }

  try {
    const args = parseArgs(process.argv.slice(2));
    const targets = await resolveTargets(args);
    getHostedAdminClient();

    console.log(
      `[openmeter-ensure-customer] ensuring ${targets.length} user(s) (customerOnly=${args.customerOnly}, provisionDb=${args.provisionDb})`,
    );

    let failed = 0;
    for (const target of targets) {
      try {
        await ensureOne({
          ...target,
          customerOnly: args.customerOnly,
          provisionDb: args.provisionDb,
        });
      } catch (err) {
        failed += 1;
        const message = err instanceof Error ? err.message : String(err);
        console.error(`[fail] ${target.clientId} ${message}`);
      }
    }

    if (failed > 0) {
      process.exit(1);
    }
  } finally {
    await closeDb({ timeout: 5 });
  }
}

main().catch((err) => {
  console.error("[openmeter-ensure-customer] fatal:", err);
  process.exit(1);
});
