/**
 * Migrate app owners onto a shared OpenMeter/Konnect customer `owner:{users.id}`.
 *
 * - Ensures the owner customer exists (usageAttribution subjectKeys = [owner key])
 * - Optionally provisions Starter + trial once on the owner customer
 * - Optionally grants remaining balance from legacy `app_…:ownerId` wallets onto
 *   the shared owner customer (best-effort; does not delete legacy customers)
 *
 * Usage:
 *   npx tsx scripts/openmeter-migrate-owner-customers.ts
 *   npx tsx scripts/openmeter-migrate-owner-customers.ts --owner-id <users.id>
 *   npx tsx scripts/openmeter-migrate-owner-customers.ts --provision --transfer-balances
 *   npx tsx scripts/openmeter-migrate-owner-customers.ts --dry-run
 */
import "./load-env-first";
import { eq } from "drizzle-orm";

import { closeDb, db } from "../src/db/index";
import { developerApps, oidcClients } from "../src/db/schema";
import {
  getHostedAdminClient,
  isHostedAdminClientAvailable,
} from "../src/lib/openmeter/admin-client";
import { buildOwnerCustomerKey } from "../src/lib/openmeter/customer-key";
import { ensureOpenMeterCustomer, listTenantCustomers } from "../src/lib/openmeter/customers";
import { createKonnectCreditGrant, getKonnectCreditBalance } from "../src/lib/openmeter/konnect-credits";
import { getHostedOpenMeterUrl } from "../src/lib/openmeter/constants";
import { shouldUseKonnectRoutes } from "../src/lib/openmeter/route-mode";
import { ensureStarterSubscriptionForAppUser } from "../src/lib/openmeter/starter-subscription";
import { ensureTrialAllowanceForAppUser } from "../src/lib/openmeter/trial-allowance";
import { getTrialFeatureKeyForApp } from "../src/lib/openmeter/client-factory";

type Args = {
  ownerId?: string;
  provision: boolean;
  transferBalances: boolean;
  dryRun: boolean;
};

function parseArgs(argv: string[]): Args {
  const args: Args = {
    provision: false,
    transferBalances: false,
    dryRun: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === "--owner-id") {
      args.ownerId = argv[++i]?.trim();
      continue;
    }
    if (token === "--provision") {
      args.provision = true;
      continue;
    }
    if (token === "--transfer-balances") {
      args.transferBalances = true;
      continue;
    }
    if (token === "--dry-run") {
      args.dryRun = true;
      continue;
    }
    throw new Error(`Unknown argument: ${token}`);
  }
  return args;
}

function usage(): string {
  return [
    "openmeter-migrate-owner-customers",
    "",
    "  (no args)              Migrate all distinct developerApps.ownerId values",
    "  --owner-id <users.id>  Migrate a single owner",
    "  --provision            Ensure Starter subscription + trial on owner customer",
    "  --transfer-balances    Grant remaining legacy app_*:ownerId balances onto owner customer",
    "  --dry-run              Print actions without calling OpenMeter mutations",
  ].join("\n");
}

async function listOwners(filterOwnerId?: string): Promise<
  Array<{ ownerId: string; apps: Array<{ developerAppId: string; publicClientId: string }> }>
> {
  const baseQuery = db
    .select({
      ownerId: developerApps.ownerId,
      developerAppId: developerApps.id,
      publicClientId: oidcClients.clientId,
    })
    .from(developerApps)
    .leftJoin(oidcClients, eq(developerApps.oidcClientId, oidcClients.id));

  const rows = filterOwnerId
    ? await baseQuery.where(eq(developerApps.ownerId, filterOwnerId))
    : await baseQuery;

  const byOwner = new Map<
    string,
    Array<{ developerAppId: string; publicClientId: string }>
  >();
  for (const row of rows) {
    if (!row.ownerId || !row.publicClientId) continue;
    const list = byOwner.get(row.ownerId) ?? [];
    list.push({
      developerAppId: row.developerAppId,
      publicClientId: row.publicClientId,
    });
    byOwner.set(row.ownerId, list);
  }

  return [...byOwner.entries()].map(([ownerId, apps]) => ({ ownerId, apps }));
}

async function provisionOwnerStarter(input: {
  ownerId: string;
  firstApp: { developerAppId: string; publicClientId: string } | undefined;
  dryRun: boolean;
}): Promise<void> {
  if (!input.firstApp) return;
  if (input.dryRun) {
    console.log(
      `  [dry-run] would provision starter/trial via app ${input.firstApp.publicClientId}`,
    );
    return;
  }
  await ensureStarterSubscriptionForAppUser({
    clientId: input.firstApp.developerAppId,
    externalUserId: input.ownerId,
  });
  await ensureTrialAllowanceForAppUser({
    clientId: input.firstApp.developerAppId,
    externalUserId: input.ownerId,
  });
  console.log(`  [ok] starter/trial ensured via ${input.firstApp.publicClientId}`);
}

async function transferLegacyAppBalance(input: {
  client: ReturnType<typeof getHostedAdminClient>;
  ownerId: string;
  customerKey: string;
  app: { developerAppId: string; publicClientId: string };
  apiKey: string | undefined;
  dryRun: boolean;
}): Promise<bigint> {
  const legacyKey = `${input.app.publicClientId}:${input.ownerId}`;
  const tenants = await listTenantCustomers(input.client, input.app.publicClientId);
  const legacy = tenants.find((row) => row.key === legacyKey);
  if (!legacy) {
    console.log(`  [skip] no legacy wallet ${legacyKey}`);
    return 0n;
  }
  const balance = await getKonnectCreditBalance({
    customerId: legacy.id,
    apiKey: input.apiKey,
  });
  if (!balance || balance.balanceUsdMicros <= 0n) {
    console.log(`  [skip] empty legacy wallet ${legacyKey}`);
    return 0n;
  }
  console.log(
    `  [legacy] ${legacyKey} balance=${balance.balanceUsdMicros.toString()} micros`,
  );
  if (input.dryRun) {
    return balance.balanceUsdMicros;
  }
  const ownerCustomer = await ensureOpenMeterCustomer(
    input.client,
    input.customerKey,
  );
  const featureKey = await getTrialFeatureKeyForApp(input.app.developerAppId);
  await createKonnectCreditGrant({
    customerId: ownerCustomer.id,
    amountUsdMicros: balance.balanceUsdMicros,
    name: "Migrated owner prepaid balance",
    description: `Transferred from legacy ${legacyKey}`,
    featureKey,
    idempotencyKey: `migrate-owner:${ownerCustomer.id}:${legacy.id}`,
    apiKey: input.apiKey,
  });
  console.log(
    `  [ok] granted ${balance.balanceUsdMicros.toString()} onto ${input.customerKey}`,
  );
  return balance.balanceUsdMicros;
}

async function migrateOwner(input: {
  ownerId: string;
  apps: Array<{ developerAppId: string; publicClientId: string }>;
  provision: boolean;
  transferBalances: boolean;
  dryRun: boolean;
}) {
  const customerKey = buildOwnerCustomerKey(input.ownerId);
  console.log(`\n[owner] ${input.ownerId} apps=${input.apps.length} key=${customerKey}`);

  if (!isHostedAdminClientAvailable()) {
    throw new Error("OpenMeter is not configured");
  }
  const apiKey = process.env.OPENMETER_API_KEY?.trim();
  if (!shouldUseKonnectRoutes(getHostedOpenMeterUrl(), apiKey)) {
    throw new Error("Owner migration requires Konnect prepaid credit routes");
  }

  const client = getHostedAdminClient();
  if (input.dryRun) {
    console.log(`  [dry-run] would ensure customer ${customerKey}`);
  } else {
    const customer = await ensureOpenMeterCustomer(
      client,
      customerKey,
      `Owner ${input.ownerId}`,
    );
    console.log(`  [ok] customer id=${customer.id}`);
  }

  if (input.provision) {
    await provisionOwnerStarter({
      ownerId: input.ownerId,
      firstApp: input.apps[0],
      dryRun: input.dryRun,
    });
  }

  if (!input.transferBalances) {
    return;
  }

  let transferMicros = 0n;
  for (const app of input.apps) {
    transferMicros += await transferLegacyAppBalance({
      client,
      ownerId: input.ownerId,
      customerKey,
      app,
      apiKey,
      dryRun: input.dryRun,
    });
  }

  if (transferMicros > 0n) {
    console.log(`  [done] total transferred micros=${transferMicros.toString()}`);
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.ownerId === "") {
    throw new Error(`Invalid --owner-id\n\n${usage()}`);
  }

  const owners = await listOwners(args.ownerId);
  if (owners.length === 0) {
    console.log("No owners found.");
    return;
  }

  console.log(
    `Migrating ${owners.length} owner(s) provision=${args.provision} transfer=${args.transferBalances} dryRun=${args.dryRun}`,
  );

  for (const owner of owners) {
    await migrateOwner({
      ownerId: owner.ownerId,
      apps: owner.apps,
      provision: args.provision,
      transferBalances: args.transferBalances,
      dryRun: args.dryRun,
    });
  }
}

main()
  .catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await closeDb({ timeout: 5 }).catch(() => undefined);
  });
