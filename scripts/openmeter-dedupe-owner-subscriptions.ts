/**
 * Deduplicate owner billing subscriptions across wallet models.
 *
 * Problem: owners can have an active subscription on both:
 *   - shared owner wallet `owner:{users.id}` (canonical)
 *   - legacy per-app wallets `app_…:{ownerId}` and `app_…:owner:{ownerId}`
 * which shows as multiple tiles on Billing / Usage.
 *
 * This script:
 *   1. Ensures the shared owner customer has an active Starter plan (with
 *      included usage discount when the plan defines one)
 *   2. Cancels leftover active subscriptions on legacy per-app owner wallets
 *
 * Does not delete Konnect customers or transfer prepaid balances (see
 * openmeter-migrate-owner-customers.ts for balance migration).
 *
 * Usage:
 *   # Preview (default)
 *   npx tsx scripts/openmeter-dedupe-owner-subscriptions.ts
 *   npx tsx scripts/openmeter-dedupe-owner-subscriptions.ts --owner-id <users.id>
 *
 *   # Apply
 *   npx tsx scripts/openmeter-dedupe-owner-subscriptions.ts --apply
 *   npx tsx scripts/openmeter-dedupe-owner-subscriptions.ts --owner-id <users.id> --apply
 *
 *   # Cancel timing (default: immediate)
 *   … --timing next_billing_cycle --apply
 */
import "./load-env-first";
import { and, eq, inArray } from "drizzle-orm";

import { closeDb, db } from "../src/db/index";
import { developerApps, oidcClients, plans } from "../src/db/schema";
import {
  getHostedAdminClient,
  isHostedAdminClientAvailable,
} from "../src/lib/openmeter/admin-client";
import {
  buildOpenMeterCustomerKey,
  buildOwnerCustomerKey,
} from "../src/lib/openmeter/customer-key";
import { ensureOpenMeterCustomer } from "../src/lib/openmeter/customers";
import { buildOpenMeterPlanKey } from "../src/lib/openmeter/plan-naming";
import { ensureStarterSubscriptionForAppUser } from "../src/lib/openmeter/starter-subscription";
import {
  isOpenMeterSubscriptionActive,
  listOpenMeterSubscriptionsForCustomer,
  type OpenMeterSubscriptionView,
} from "../src/lib/openmeter/subscription-read";

type Timing = "immediate" | "next_billing_cycle";

type Args = {
  ownerId?: string;
  apply: boolean;
  timing: Timing;
};

type OwnedApp = {
  developerAppId: string;
  publicClientId: string;
  name: string;
};

type StarterRef = {
  planId: string;
  clientId: string;
  openmeterPlanId: string | null;
  planKey: string;
};

type CancelTarget = {
  customerKey: string;
  customerId: string;
  subscriptionId: string;
  planKey: string | null;
  status: string;
  reason: string;
};

function usage(): string {
  return [
    "openmeter-dedupe-owner-subscriptions",
    "",
    "Collapse duplicate owner subscriptions onto the shared owner:{users.id} wallet.",
    "",
    "Options:",
    "  (no args)              Dry-run all owners who have apps",
    "  --owner-id <users.id>  Limit to one owner",
    "  --dry-run              Preview only (default)",
    "  --apply                Cancel legacy + ensure owner Starter",
    "  --timing immediate|next_billing_cycle",
    "                         Cancel/change timing (default: immediate)",
  ].join("\n");
}

function parseArgs(argv: string[]): Args {
  const args: Args = { apply: false, timing: "immediate" };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    switch (token) {
      case "--apply":
        args.apply = true;
        break;
      case "--dry-run":
        args.apply = false;
        break;
      case "--owner-id": {
        const value = argv[++i]?.trim();
        if (!value) throw new Error("--owner-id requires a value");
        args.ownerId = value;
        break;
      }
      case "--timing": {
        const value = argv[++i]?.trim();
        if (value !== "immediate" && value !== "next_billing_cycle") {
          throw new Error("--timing must be immediate|next_billing_cycle");
        }
        args.timing = value;
        break;
      }
      case "--help":
      case "-h":
        console.log(usage());
        process.exit(0);
        break;
      default:
        throw new Error(`Unknown argument: ${token}\n\n${usage()}`);
    }
  }
  return args;
}

async function listOwners(filterOwnerId?: string): Promise<
  Array<{ ownerId: string; apps: OwnedApp[] }>
> {
  const baseQuery = db
    .select({
      ownerId: developerApps.ownerId,
      developerAppId: developerApps.id,
      name: developerApps.name,
      publicClientId: oidcClients.clientId,
    })
    .from(developerApps)
    .leftJoin(oidcClients, eq(developerApps.oidcClientId, oidcClients.id));

  const rows = filterOwnerId
    ? await baseQuery.where(eq(developerApps.ownerId, filterOwnerId))
    : await baseQuery;

  const byOwner = new Map<string, OwnedApp[]>();
  for (const row of rows) {
    if (!row.ownerId) continue;
    const publicClientId = row.publicClientId?.trim() || row.developerAppId;
    const list = byOwner.get(row.ownerId) ?? [];
    list.push({
      developerAppId: row.developerAppId,
      publicClientId,
      name: row.name,
    });
    byOwner.set(row.ownerId, list);
  }

  const owners = [...byOwner.entries()].map(([ownerId, apps]) => ({
    ownerId,
    apps: apps.toSorted((a, b) => a.name.localeCompare(b.name)),
  }));
  return owners.toSorted((a, b) => a.ownerId.localeCompare(b.ownerId));
}

async function loadStarterRefs(developerAppIds: string[]): Promise<StarterRef[]> {
  if (developerAppIds.length === 0) return [];
  const rows = await db
    .select({
      id: plans.id,
      clientId: plans.clientId,
      openmeterPlanId: plans.openmeterPlanId,
    })
    .from(plans)
    .where(
      and(
        eq(plans.isStarterDefault, true),
        eq(plans.status, "active"),
        inArray(plans.clientId, developerAppIds),
      ),
    );

  return rows.map((row) => ({
    planId: row.id,
    clientId: row.clientId,
    openmeterPlanId: row.openmeterPlanId,
    planKey: buildOpenMeterPlanKey(row.clientId, row.id),
  }));
}

function isStarterSubscription(
  sub: OpenMeterSubscriptionView,
  starters: StarterRef[],
): boolean {
  for (const starter of starters) {
    if (sub.planKey && sub.planKey === starter.planKey) return true;
    if (
      starter.openmeterPlanId &&
      sub.planId &&
      sub.planId === starter.openmeterPlanId
    ) {
      return true;
    }
  }
  const key = sub.planKey?.toLowerCase() ?? "";
  return key.includes("starter");
}

async function findCustomerIdByKey(
  client: ReturnType<typeof getHostedAdminClient>,
  customerKey: string,
): Promise<string | null> {
  try {
    const listed = await client.customers.list({
      key: customerKey,
      page: 1,
      pageSize: 20,
    });
    const match = (listed?.items ?? []).find((item) => item.key === customerKey);
    return match?.id ?? null;
  } catch {
    return null;
  }
}

async function listActiveSubs(
  client: ReturnType<typeof getHostedAdminClient>,
  customerId: string,
): Promise<OpenMeterSubscriptionView[]> {
  const listed = await listOpenMeterSubscriptionsForCustomer(client, customerId);
  return listed.filter((item) => isOpenMeterSubscriptionActive(item.status));
}

function legacyCustomerKeys(ownerId: string, apps: OwnedApp[]): string[] {
  const ownerKey = buildOwnerCustomerKey(ownerId);
  return apps.flatMap((app) => [
    buildOpenMeterCustomerKey(app.publicClientId, ownerId),
    buildOpenMeterCustomerKey(app.publicClientId, ownerKey),
  ]);
}

async function cancelSubscription(input: {
  client: ReturnType<typeof getHostedAdminClient>;
  subscriptionId: string;
  timing: Timing;
  dryRun: boolean;
  label: string;
}): Promise<void> {
  if (input.dryRun) {
    console.log(`  [dry-run] would cancel ${input.subscriptionId} (${input.label})`);
    return;
  }
  await input.client.subscriptions.cancel(input.subscriptionId, {
    timing: input.timing,
  });
  console.log(`  [cancel] ${input.subscriptionId} (${input.label})`);
}

async function resolveOwnerCustomerId(input: {
  client: ReturnType<typeof getHostedAdminClient>;
  ownerId: string;
  ownerKey: string;
  dryRun: boolean;
}): Promise<string | null> {
  if (input.dryRun) {
    const existing = await findCustomerIdByKey(input.client, input.ownerKey);
    if (!existing) {
      console.log(
        `  [dry-run] owner customer ${input.ownerKey} missing; would create + Starter`,
      );
    }
    return existing;
  }
  const customer = await ensureOpenMeterCustomer(
    input.client,
    input.ownerKey,
    `Owner ${input.ownerId}`,
  );
  console.log(`  [ok] owner customer id=${customer.id}`);
  return customer.id;
}

async function cancelOwnerWalletExtras(input: {
  client: ReturnType<typeof getHostedAdminClient>;
  ownerActive: OpenMeterSubscriptionView[];
  starters: StarterRef[];
  timing: Timing;
  dryRun: boolean;
}): Promise<number> {
  let cancels = 0;
  const ownerStarters = input.ownerActive.filter((s) =>
    isStarterSubscription(s, input.starters),
  );
  const ownerNonStarters = input.ownerActive.filter(
    (s) => !isStarterSubscription(s, input.starters),
  );

  for (const sub of ownerNonStarters) {
    await cancelSubscription({
      client: input.client,
      subscriptionId: sub.id,
      timing: input.timing,
      dryRun: input.dryRun,
      label: `owner non-starter planKey=${sub.planKey ?? "?"}`,
    });
    cancels += 1;
  }

  const keepStarterId = ownerStarters[0]?.id ?? null;
  for (const sub of ownerStarters.slice(1)) {
    await cancelSubscription({
      client: input.client,
      subscriptionId: sub.id,
      timing: input.timing,
      dryRun: input.dryRun,
      label: `duplicate owner Starter (keeping ${keepStarterId})`,
    });
    cancels += 1;
  }
  return cancels;
}

async function ensureOwnerStarter(input: {
  ownerId: string;
  ownerKey: string;
  firstApp: OwnedApp | undefined;
  hasStarter: boolean;
  keepStarterId: string | null;
  dryRun: boolean;
}): Promise<boolean> {
  if (input.hasStarter) {
    console.log(`  [ok] owner already has Starter ${input.keepStarterId}`);
    return false;
  }
  if (!input.firstApp) {
    console.log(`  [skip] no apps to provision Starter from`);
    return false;
  }
  if (input.dryRun) {
    console.log(
      `  [dry-run] would ensure Starter on ${input.ownerKey} via app ${input.firstApp.publicClientId}`,
    );
    return true;
  }
  const result = await ensureStarterSubscriptionForAppUser({
    clientId: input.firstApp.developerAppId,
    externalUserId: input.ownerId,
  });
  console.log(
    `  [ok] starter ensured sub=${result.openmeterSubscriptionId} created=${result.created}`,
  );
  return true;
}

async function collectLegacyCancelTargets(input: {
  client: ReturnType<typeof getHostedAdminClient>;
  ownerId: string;
  apps: OwnedApp[];
}): Promise<CancelTarget[]> {
  const cancelTargets: CancelTarget[] = [];
  for (const customerKey of legacyCustomerKeys(input.ownerId, input.apps)) {
    const customerId = await findCustomerIdByKey(input.client, customerKey);
    if (!customerId) {
      console.log(`  [skip] no legacy customer ${customerKey}`);
      continue;
    }
    const active = await listActiveSubs(input.client, customerId);
    if (active.length === 0) {
      console.log(`  [skip] no active legacy subs ${customerKey}`);
      continue;
    }
    cancelTargets.push(
      ...active.map((sub) => ({
        customerKey,
        customerId,
        subscriptionId: sub.id,
        planKey: sub.planKey,
        status: sub.status,
        reason: "legacy per-app owner wallet",
      })),
    );
  }
  return cancelTargets;
}

async function processOwner(input: {
  ownerId: string;
  apps: OwnedApp[];
  apply: boolean;
  timing: Timing;
}): Promise<{
  legacyCancels: number;
  ownerNonStarterCancels: number;
  ensuredStarter: boolean;
}> {
  const dryRun = !input.apply;
  const client = getHostedAdminClient();
  const ownerKey = buildOwnerCustomerKey(input.ownerId);
  const starters = await loadStarterRefs(input.apps.map((a) => a.developerAppId));
  const firstApp = input.apps[0];

  console.log(
    `\n[owner] ${input.ownerId} apps=${input.apps.length} key=${ownerKey}`,
  );
  for (const app of input.apps) {
    console.log(`  app ${app.publicClientId} (${app.name})`);
  }

  const ownerCustomerId = await resolveOwnerCustomerId({
    client,
    ownerId: input.ownerId,
    ownerKey,
    dryRun,
  });

  const ownerActive: OpenMeterSubscriptionView[] = ownerCustomerId
    ? await listActiveSubs(client, ownerCustomerId)
    : [];

  for (const sub of ownerActive) {
    const starter = isStarterSubscription(sub, starters);
    console.log(
      `  [owner-sub] id=${sub.id} status=${sub.status} planKey=${sub.planKey ?? "?"} starter=${starter}`,
    );
  }

  const ownerStarters = ownerActive.filter((s) =>
    isStarterSubscription(s, starters),
  );
  const ownerNonStarterCancels = await cancelOwnerWalletExtras({
    client,
    ownerActive,
    starters,
    timing: input.timing,
    dryRun,
  });

  const ensuredStarter = await ensureOwnerStarter({
    ownerId: input.ownerId,
    ownerKey,
    firstApp,
    hasStarter: ownerStarters.length > 0,
    keepStarterId: ownerStarters[0]?.id ?? null,
    dryRun,
  });

  const cancelTargets = await collectLegacyCancelTargets({
    client,
    ownerId: input.ownerId,
    apps: input.apps,
  });

  for (const target of cancelTargets) {
    console.log(
      `  [legacy] ${target.customerKey} sub=${target.subscriptionId} planKey=${target.planKey ?? "?"} status=${target.status}`,
    );
    await cancelSubscription({
      client,
      subscriptionId: target.subscriptionId,
      timing: input.timing,
      dryRun,
      label: `${target.reason} ${target.customerKey}`,
    });
  }

  return {
    legacyCancels: cancelTargets.length,
    ownerNonStarterCancels,
    ensuredStarter,
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (!isHostedAdminClientAvailable()) {
    throw new Error("OpenMeter is not configured (OPENMETER_URL / OPENMETER_API_KEY)");
  }

  const owners = await listOwners(args.ownerId);
  if (owners.length === 0) {
    console.log("No owners found.");
    return;
  }

  console.log(
    `Dedupe owner subscriptions: owners=${owners.length} apply=${args.apply} timing=${args.timing}`,
  );

  let legacyCancels = 0;
  let ownerNonStarterCancels = 0;
  let ensuredStarter = 0;

  for (const owner of owners) {
    const stats = await processOwner({
      ownerId: owner.ownerId,
      apps: owner.apps,
      apply: args.apply,
      timing: args.timing,
    });
    legacyCancels += stats.legacyCancels;
    ownerNonStarterCancels += stats.ownerNonStarterCancels;
    if (stats.ensuredStarter) ensuredStarter += 1;
  }

  console.log("\nSummary");
  console.log(`  legacy cancels:            ${legacyCancels}`);
  console.log(`  owner non-starter cancels: ${ownerNonStarterCancels}`);
  console.log(`  owners needing starter:    ${ensuredStarter}`);
  if (!args.apply) {
    console.log("\nDry-run only. Re-run with --apply to mutate Konnect.");
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
