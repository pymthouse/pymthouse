/**
 * Migrate app owners onto a shared OpenMeter/Konnect customer keyed by bare
 * `{users.id}`, subscribed to the platform Owner Starter plan.
 *
 * - Ensures the bare-key owner customer exists with transitional subjectKeys
 * - Syncs / publishes the platform Owner Starter plan
 * - Optionally provisions Owner Starter on the bare customer
 * - Optionally transfers prepaid balances from legacy `owner:{id}` and
 *   `app_…:ownerId` / `app_…:owner:{id}` wallets
 * - Cancels active subscriptions on legacy customers
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
import {
  getHostedOpenMeterUrl,
  DEFAULT_TRIAL_FEATURE_KEY,
} from "../src/lib/openmeter/constants";
import {
  buildOpenMeterCustomerKey,
  buildOwnerCustomerKey,
  buildOwnerWireSubject,
} from "../src/lib/openmeter/customer-key";
import {
  ensureOwnerCustomer,
} from "../src/lib/openmeter/customers";
import {
  createKonnectCreditGrant,
  getKonnectCreditBalance,
} from "../src/lib/openmeter/konnect-credits";
import {
  ensureOwnerStarterPlanSynced,
  ensureOwnerStarterSubscription,
  OWNER_STARTER_PLAN_KEY,
} from "../src/lib/openmeter/owner-starter-plan";
import { shouldUseKonnectRoutes } from "../src/lib/openmeter/route-mode";
import {
  isOpenMeterSubscriptionActive,
  listOpenMeterSubscriptionsForCustomer,
} from "../src/lib/openmeter/subscription-read";

type Args = {
  ownerId?: string;
  provision: boolean;
  transferBalances: boolean;
  cancelLegacy: boolean;
  dryRun: boolean;
};

type OwnedApp = {
  developerAppId: string;
  publicClientId: string;
};

function parseArgs(argv: string[]): Args {
  const args: Args = {
    provision: false,
    transferBalances: false,
    cancelLegacy: false,
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
    if (token === "--cancel-legacy") {
      args.cancelLegacy = true;
      continue;
    }
    if (token === "--dry-run") {
      args.dryRun = true;
      continue;
    }
    if (token === "--help" || token === "-h") {
      console.log(usage());
      process.exit(0);
    }
    throw new Error(`Unknown argument: ${token}`);
  }
  return args;
}

function usage(): string {
  return [
    "openmeter-migrate-owner-customers",
    "",
    "Migrate owners to bare {users.id} Konnect customers + platform Owner Starter.",
    "",
    "  (no args)              Migrate all distinct developerApps.ownerId values",
    "  --owner-id <users.id>  Migrate a single owner",
    "  --provision            Ensure Owner Starter subscription on bare customer",
    "  --transfer-balances    Grant remaining balances from legacy wallets",
    "  --cancel-legacy        Cancel active subscriptions on legacy customers",
    "  --dry-run              Print actions without OpenMeter mutations",
    "  --help",
  ].join("\n");
}

async function listOwners(filterOwnerId?: string): Promise<
  Array<{ ownerId: string; apps: OwnedApp[] }>
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

  const byOwner = new Map<string, OwnedApp[]>();
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

async function findCustomerIdByKey(
  client: ReturnType<typeof getHostedAdminClient>,
  customerKey: string,
): Promise<string | null> {
  const listed = await client.customers.list({
    key: customerKey,
    page: 1,
    pageSize: 50,
  });
  const match = (listed?.items ?? []).find((item) => item.key === customerKey);
  return match?.id ?? null;
}

async function transferBalanceFromLegacyCustomer(input: {
  client: ReturnType<typeof getHostedAdminClient>;
  legacyCustomerId: string;
  legacyKey: string;
  ownerCustomerId: string;
  ownerKey: string;
  featureKey: string;
  apiKey: string | undefined;
  dryRun: boolean;
}): Promise<bigint> {
  const balance = await getKonnectCreditBalance({
    customerId: input.legacyCustomerId,
    apiKey: input.apiKey,
  });
  if (!balance || balance.balanceUsdMicros <= 0n) {
    console.log(`  [skip] empty legacy wallet ${input.legacyKey}`);
    return 0n;
  }
  console.log(
    `  [legacy] ${input.legacyKey} balance=${balance.balanceUsdMicros.toString()} micros`,
  );
  if (input.dryRun) {
    return balance.balanceUsdMicros;
  }
  await createKonnectCreditGrant({
    customerId: input.ownerCustomerId,
    amountUsdMicros: balance.balanceUsdMicros,
    name: "Migrated owner prepaid balance",
    description: `Transferred from legacy ${input.legacyKey}`,
    featureKey: input.featureKey,
    idempotencyKey: `migrate-owner-bare:${input.ownerCustomerId}:${input.legacyCustomerId}`,
    apiKey: input.apiKey,
  });
  console.log(
    `  [ok] granted ${balance.balanceUsdMicros.toString()} onto ${input.ownerKey}`,
  );
  return balance.balanceUsdMicros;
}

function legacyCustomerKeys(ownerId: string, apps: OwnedApp[]): string[] {
  const wire = buildOwnerWireSubject(ownerId);
  const keys = [wire];
  for (const app of apps) {
    keys.push(
      buildOpenMeterCustomerKey(app.publicClientId, ownerId),
      buildOpenMeterCustomerKey(app.publicClientId, wire),
    );
  }
  return [...new Set(keys)];
}

async function releaseLegacySubjectKeys(input: {
  client: ReturnType<typeof getHostedAdminClient>;
  customerId: string;
  customerKey: string;
  dryRun: boolean;
}): Promise<void> {
  if (input.dryRun) {
    console.log(
      `  [dry-run] would clear subjectKeys on legacy ${input.customerKey}`,
    );
    return;
  }
  // Free wire subjects for the bare owner customer. Use a deprecated subject
  // so Konnect still has at least one key, including when the legacy customer
  // key itself is owner:{id}.
  const retiredKey = `deprecated:${input.customerKey}`;
  try {
    await input.client.customers.update(input.customerId, {
      name: `Legacy ${input.customerKey}`,
      usageAttribution: { subjectKeys: [retiredKey] },
    });
    console.log(`  [ok] released subjectKeys on ${input.customerKey} → ${retiredKey}`);
  } catch (err) {
    console.warn(
      `  [warn] could not release subjectKeys on ${input.customerKey}:`,
      err instanceof Error ? err.message : String(err),
    );
  }
}

async function cancelLegacySubscriptions(input: {
  client: ReturnType<typeof getHostedAdminClient>;
  customerId: string;
  customerKey: string;
  dryRun: boolean;
}): Promise<number> {
  const listed = await listOpenMeterSubscriptionsForCustomer(
    input.client,
    input.customerId,
  );
  const active = listed.filter((s) => isOpenMeterSubscriptionActive(s.status));
  let cancels = 0;
  for (const sub of active) {
    if (input.dryRun) {
      console.log(
        `  [dry-run] would cancel ${sub.id} on legacy ${input.customerKey}`,
      );
    } else {
      await input.client.subscriptions.cancel(sub.id, { timing: "immediate" });
      console.log(`  [cancel] ${sub.id} on legacy ${input.customerKey}`);
    }
    cancels += 1;
  }
  return cancels;
}

async function processLegacyWallets(input: {
  client: ReturnType<typeof getHostedAdminClient>;
  ownerId: string;
  apps: OwnedApp[];
  customerKey: string;
  ownerCustomerId: string | null;
  transferBalances: boolean;
  cancelLegacy: boolean;
  dryRun: boolean;
  apiKey: string | undefined;
}): Promise<bigint> {
  let transferMicros = 0n;
  if (!input.transferBalances && !input.cancelLegacy) {
    return transferMicros;
  }

  for (const legacyKey of legacyCustomerKeys(input.ownerId, input.apps)) {
    if (legacyKey === input.customerKey) continue;
    const legacyId = await findCustomerIdByKey(input.client, legacyKey);
    if (!legacyId) {
      console.log(`  [skip] no legacy wallet ${legacyKey}`);
      continue;
    }

    if (input.transferBalances && input.ownerCustomerId) {
      transferMicros += await transferBalanceFromLegacyCustomer({
        client: input.client,
        legacyCustomerId: legacyId,
        legacyKey,
        ownerCustomerId: input.ownerCustomerId,
        ownerKey: input.customerKey,
        featureKey: DEFAULT_TRIAL_FEATURE_KEY,
        apiKey: input.apiKey,
        dryRun: input.dryRun,
      });
    }

    if (input.cancelLegacy) {
      await cancelLegacySubscriptions({
        client: input.client,
        customerId: legacyId,
        customerKey: legacyKey,
        dryRun: input.dryRun,
      });
      await releaseLegacySubjectKeys({
        client: input.client,
        customerId: legacyId,
        customerKey: legacyKey,
        dryRun: input.dryRun,
      });
    }
  }
  return transferMicros;
}

async function migrateOwner(input: {
  ownerId: string;
  apps: OwnedApp[];
  provision: boolean;
  transferBalances: boolean;
  cancelLegacy: boolean;
  dryRun: boolean;
}) {
  const customerKey = buildOwnerCustomerKey(input.ownerId);
  const publicClientIds = input.apps.map((a) => a.publicClientId);
  console.log(
    `\n[owner] ${input.ownerId} apps=${input.apps.length} key=${customerKey}`,
  );

  if (!isHostedAdminClientAvailable()) {
    throw new Error("OpenMeter is not configured");
  }
  const apiKey = process.env.OPENMETER_API_KEY?.trim();
  if (!shouldUseKonnectRoutes(getHostedOpenMeterUrl(), apiKey)) {
    throw new Error("Owner migration requires Konnect prepaid credit routes");
  }

  const client = getHostedAdminClient();

  if (input.dryRun) {
    console.log(
      `  [dry-run] would ensure customer ${customerKey} with subjects for ${publicClientIds.length} apps`,
    );
  } else {
    const customer = await ensureOwnerCustomer(
      client,
      input.ownerId,
      publicClientIds,
    );
    console.log(`  [ok] customer id=${customer.id} key=${customer.key}`);
  }

  const ownerCustomerId = input.dryRun
    ? await findCustomerIdByKey(client, customerKey)
    : (await ensureOwnerCustomer(client, input.ownerId, publicClientIds)).id;

  if (!ownerCustomerId && !input.dryRun) {
    throw new Error(`Failed to resolve bare owner customer ${customerKey}`);
  }

  const transferMicros = await processLegacyWallets({
    client,
    ownerId: input.ownerId,
    apps: input.apps,
    customerKey,
    ownerCustomerId,
    transferBalances: input.transferBalances,
    cancelLegacy: input.cancelLegacy,
    dryRun: input.dryRun,
    apiKey,
  });

  if (transferMicros > 0n) {
    console.log(`  [done] total transferred micros=${transferMicros.toString()}`);
  }

  // Re-ensure after releasing legacy subjects so wire keys can move onto bare.
  if (!input.dryRun && input.cancelLegacy) {
    await ensureOwnerCustomer(client, input.ownerId, publicClientIds);
  }

  if (!input.provision) {
    return;
  }
  if (input.dryRun) {
    console.log(
      `  [dry-run] would ensure Owner Starter (${OWNER_STARTER_PLAN_KEY})`,
    );
    return;
  }
  const ensured = await ensureOwnerStarterSubscription({
    ownerUserId: input.ownerId,
    publicClientIds,
  });
  console.log(
    `  [ok] Owner Starter sub=${ensured.openmeterSubscriptionId} ` +
      `plan=${ensured.planKey} created=${ensured.created}`,
  );
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.ownerId === "") {
    throw new Error(`Invalid --owner-id\n\n${usage()}`);
  }

  if (!isHostedAdminClientAvailable()) {
    throw new Error("OpenMeter is not configured");
  }

  if (args.dryRun) {
    console.log(`[dry-run] would ensure Owner Starter plan ${OWNER_STARTER_PLAN_KEY}`);
  } else {
    const plan = await ensureOwnerStarterPlanSynced();
    console.log(
      `[ok] Owner Starter plan id=${plan.openmeterPlanId} key=${plan.key} ` +
        `included=${plan.includedUsdMicros}`,
    );
  }

  const owners = await listOwners(args.ownerId);
  if (owners.length === 0) {
    console.log("No owners found.");
    return;
  }

  console.log(
    `Migrating ${owners.length} owner(s) provision=${args.provision} ` +
      `transfer=${args.transferBalances} cancelLegacy=${args.cancelLegacy} ` +
      `dryRun=${args.dryRun}`,
  );

  for (const owner of owners) {
    await migrateOwner({
      ownerId: owner.ownerId,
      apps: owner.apps,
      provision: args.provision,
      transferBalances: args.transferBalances,
      cancelLegacy: args.cancelLegacy,
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
