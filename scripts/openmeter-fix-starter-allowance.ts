/**
 * Fix Starter included-usage allowance and resubscribe onto plan versions that
 * carry Konnect rate-card `discounts.usage`.
 *
 * Usage:
 *   npx tsx scripts/openmeter-fix-starter-allowance.ts
 *   npx tsx scripts/openmeter-fix-starter-allowance.ts --owner-id <users.id>
 *   npx tsx scripts/openmeter-fix-starter-allowance.ts --owner-id <users.id> --apply
 *   npx tsx scripts/openmeter-fix-starter-allowance.ts --client-id app_xxx --apply
 */
import "./load-env-first";
import { and, eq, inArray } from "drizzle-orm";

import { closeDb, db } from "../src/db/index";
import { developerApps, oidcClients, plans } from "../src/db/schema";
import {
  getHostedAdminClient,
  isHostedAdminClientAvailable,
} from "../src/lib/openmeter/admin-client";
import { buildOwnerCustomerKey } from "../src/lib/openmeter/customer-key";
import {
  ensureOpenMeterCustomer,
  findOpenMeterCustomerByKey,
} from "../src/lib/openmeter/customers";
import { buildOpenMeterPlanKey } from "../src/lib/openmeter/plan-naming";
import { syncPlanToOpenMeter } from "../src/lib/openmeter/plans-sync";
import { ensureStarterSubscriptionForAppUser } from "../src/lib/openmeter/starter-subscription";
import {
  isOpenMeterSubscriptionActive,
  listOpenMeterSubscriptionsForCustomer,
} from "../src/lib/openmeter/subscription-read";
import { defaultStarterIncludedUsdMicros } from "../src/lib/starter-default-plan-display";
import {
  changeKonnectSubscription,
  getKonnectPlan,
  isUsableAllowancePlan,
  listActiveKonnectSubscriptions,
  parseSubscriptionTiming,
  rateCardsHaveUsageDiscount,
  readUsageDiscountMicros,
  requireKonnectConfig,
  takeArgValue,
  type KonnectPlan,
  type KonnectSubscription,
  type SubscriptionChangeTiming,
} from "./lib/openmeter-konnect-migrate";

type Args = {
  apply: boolean;
  ownerId?: string;
  clientId?: string;
  timing: SubscriptionChangeTiming;
};

type StarterRow = {
  id: string;
  clientId: string;
  includedUsdMicros: string | null;
  openmeterPlanId: string | null;
};

type OwnedApp = {
  developerAppId: string;
  publicClientId: string;
  name: string;
};

function usage(): string {
  return [
    "openmeter-fix-starter-allowance",
    "",
    "Republish Starter with discounts.usage and move subscriptions onto it.",
    "",
    "Options:",
    "  --dry-run                 Preview only (default)",
    "  --apply                   Write DB + Konnect changes",
    "  --owner-id <users.id>     Fix owner:{id} wallet (cancel + recreate)",
    "  --client-id <app_id>      Limit sync / prefer this app when ensuring owner Starter",
    "  --timing immediate|next_billing_cycle",
  ].join("\n");
}

function statsKeyForChangeResult(
  result: "changed" | "skipped" | "error",
): "changed" | "skipped" | "errors" {
  if (result === "changed") return "changed";
  if (result === "error") return "errors";
  return "skipped";
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
      case "--owner-id":
        args.ownerId = takeArgValue(argv, i, token);
        i += 1;
        break;
      case "--client-id":
        args.clientId = takeArgValue(argv, i, token);
        i += 1;
        break;
      case "--timing":
        args.timing = parseSubscriptionTiming(takeArgValue(argv, i, token));
        i += 1;
        break;
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

async function loadStarterRows(clientIds?: string[]): Promise<StarterRow[]> {
  const conditions = [
    eq(plans.isStarterDefault, true),
    eq(plans.status, "active"),
  ];
  if (clientIds && clientIds.length > 0) {
    conditions.push(inArray(plans.clientId, clientIds));
  }
  return db
    .select({
      id: plans.id,
      clientId: plans.clientId,
      includedUsdMicros: plans.includedUsdMicros,
      openmeterPlanId: plans.openmeterPlanId,
    })
    .from(plans)
    .where(and(...conditions));
}

async function listOwnedApps(ownerId: string): Promise<OwnedApp[]> {
  const rows = await db
    .select({
      developerAppId: developerApps.id,
      name: developerApps.name,
      publicClientId: oidcClients.clientId,
    })
    .from(developerApps)
    .leftJoin(oidcClients, eq(developerApps.oidcClientId, oidcClients.id))
    .where(eq(developerApps.ownerId, ownerId));

  return rows
    .map((row) => ({
      developerAppId: row.developerAppId,
      name: row.name,
      publicClientId: row.publicClientId?.trim() || row.developerAppId,
    }))
    .filter((row) => row.publicClientId.length > 0);
}

async function listOwnerIdsForFix(clientId?: string): Promise<string[]> {
  if (clientId?.trim()) {
    const id = clientId.trim();
    const byPublic = await db
      .select({ ownerId: developerApps.ownerId })
      .from(developerApps)
      .innerJoin(oidcClients, eq(developerApps.oidcClientId, oidcClients.id))
      .where(eq(oidcClients.clientId, id))
      .limit(1);
    if (byPublic[0]?.ownerId) return [byPublic[0].ownerId];
    const byAppId = await db
      .select({ ownerId: developerApps.ownerId })
      .from(developerApps)
      .where(eq(developerApps.id, id))
      .limit(1);
    return byAppId[0]?.ownerId ? [byAppId[0].ownerId] : [];
  }

  const rows = await db
    .selectDistinct({ ownerId: developerApps.ownerId })
    .from(developerApps);
  return rows.map((r) => r.ownerId).filter(Boolean);
}

async function ensureIncludedUsdMicros(
  row: StarterRow,
  apply: boolean,
): Promise<StarterRow> {
  const current = row.includedUsdMicros?.trim() || "";
  if (/^\d+$/.test(current) && BigInt(current) > 0n) {
    return row;
  }
  const next = defaultStarterIncludedUsdMicros();
  console.log(
    `  [db] ${row.clientId}: includedUsdMicros ${current || "(empty)"} -> ${next}`,
  );
  if (!apply) {
    return { ...row, includedUsdMicros: next };
  }
  await db
    .update(plans)
    .set({
      includedUsdMicros: next,
      updatedAt: new Date().toISOString(),
    })
    .where(eq(plans.id, row.id));
  return { ...row, includedUsdMicros: next };
}

async function logCurrentPlanDiscount(
  baseUrl: string,
  apiKey: string,
  row: StarterRow,
  planKey: string,
): Promise<void> {
  if (!row.openmeterPlanId?.trim()) {
    console.log(`  [dry-run] ${row.clientId} key=${planKey} — would sync allowance plan`);
    return;
  }
  try {
    const existing = await getKonnectPlan(baseUrl, apiKey, row.openmeterPlanId.trim());
    const discount = readUsageDiscountMicros(existing);
    console.log(
      `  [dry-run] ${row.clientId} key=${planKey} hasDiscount=${Boolean(discount)} ` +
        `— would sync+publish allowance plan`,
    );
  } catch {
    console.log(`  [dry-run] ${row.clientId} key=${planKey} — would sync allowance plan`);
  }
}

async function syncStarterWithAllowance(input: {
  baseUrl: string;
  apiKey: string;
  row: StarterRow;
  apply: boolean;
}): Promise<{ planKey: string; planId: string | null }> {
  const planKey = buildOpenMeterPlanKey(input.row.clientId, input.row.id);
  const row = await ensureIncludedUsdMicros(input.row, input.apply);

  if (!input.apply) {
    await logCurrentPlanDiscount(input.baseUrl, input.apiKey, row, planKey);
    return { planKey, planId: row.openmeterPlanId };
  }

  const sync = await syncPlanToOpenMeter(row.id);
  if (!sync.ok || !sync.openmeterPlanId) {
    throw new Error(
      `syncPlanToOpenMeter failed for ${row.clientId}/${row.id}: ${sync.error ?? "no plan id"}`,
    );
  }

  const published = await getKonnectPlan(input.baseUrl, input.apiKey, sync.openmeterPlanId);
  if (!isUsableAllowancePlan(published)) {
    throw new Error(
      `Published Starter ${published.id} key=${planKey} missing discounts.usage`,
    );
  }

  console.log(
    `  [plan] ${row.clientId} -> ${published.id} v${published.version ?? "?"} ` +
      `discount=${readUsageDiscountMicros(published)}`,
  );
  return { planKey, planId: published.id };
}

async function cancelOwnerSubs(input: {
  apply: boolean;
  timing: SubscriptionChangeTiming;
  ownerId: string;
  customerId: string;
}): Promise<number> {
  const client = getHostedAdminClient();
  const active = (
    await listOpenMeterSubscriptionsForCustomer(client, input.customerId)
  ).filter((sub) => isOpenMeterSubscriptionActive(sub.status));

  for (const sub of active) {
    console.log(
      `  [owner-sub] id=${sub.id} status=${sub.status} planKey=${sub.planKey ?? "?"}`,
    );
  }

  if (!input.apply) {
    return active.length;
  }

  for (const sub of active) {
    await client.subscriptions.cancel(sub.id, { timing: input.timing });
    console.log(`  [cancel] ${sub.id}`);
  }
  return active.length;
}

async function verifyEnsuredStarter(input: {
  baseUrl: string;
  apiKey: string;
  customerId: string;
  subscriptionId: string | null;
}): Promise<void> {
  if (!input.subscriptionId) return;
  const client = getHostedAdminClient();
  const refreshed = await listOpenMeterSubscriptionsForCustomer(
    client,
    input.customerId,
  );
  const current = refreshed.find((s) => s.id === input.subscriptionId);
  if (!current?.planId) return;
  const plan = await getKonnectPlan(input.baseUrl, input.apiKey, current.planId);
  console.log(
    `  [verify] allowance ok=${isUsableAllowancePlan(plan)} ` +
      `hasDiscount=${Boolean(readUsageDiscountMicros(plan))}`,
  );
}

async function fixOwnerWallet(input: {
  baseUrl: string;
  apiKey: string;
  ownerId: string;
  apply: boolean;
  timing: SubscriptionChangeTiming;
  /** Prefer this app when recreating the owner Starter subscription. */
  preferredClientId?: string;
}): Promise<void> {
  const apps = await listOwnedApps(input.ownerId);
  if (apps.length === 0) {
    console.log(`[owner] ${input.ownerId}: no owned apps — nothing to do`);
    return;
  }

  const preferred = input.preferredClientId?.trim();
  const ensureApp =
    (preferred &&
      apps.find(
        (a) => a.publicClientId === preferred || a.developerAppId === preferred,
      )) ||
    apps[0];

  const ownerKey = buildOwnerCustomerKey(input.ownerId);
  console.log(
    `\n[owner] ${input.ownerId} key=${ownerKey} apps=${apps.length} ` +
      `ensureVia=${ensureApp.publicClientId}`,
  );

  const starters = await loadStarterRows(apps.map((a) => a.developerAppId));
  for (const row of starters) {
    await syncStarterWithAllowance({
      baseUrl: input.baseUrl,
      apiKey: input.apiKey,
      row,
      apply: input.apply,
    });
  }

  if (!isHostedAdminClientAvailable()) {
    throw new Error("OpenMeter admin client is not available");
  }

  const client = getHostedAdminClient();
  if (!input.apply) {
    const existing = await findOpenMeterCustomerByKey(client, ownerKey);
    console.log(
      `  [dry-run] customer=${existing?.id ?? "missing"} would cancel active ` +
        `subs then ensure Starter via ${ensureApp.publicClientId}`,
    );
    return;
  }

  const customer = await ensureOpenMeterCustomer(
    client,
    ownerKey,
    `Owner ${input.ownerId}`,
  );

  const cancelCount = await cancelOwnerSubs({
    apply: input.apply,
    timing: input.timing,
    ownerId: input.ownerId,
    customerId: customer.id,
  });

  const ensured = await ensureStarterSubscriptionForAppUser({
    clientId: ensureApp.developerAppId,
    externalUserId: input.ownerId,
  });
  console.log(
    `  [ok] starter ensured created=${ensured.created} planId=${ensured.planId} ` +
      `via=${ensureApp.publicClientId} cancelled=${cancelCount}`,
  );
  await verifyEnsuredStarter({
    baseUrl: input.baseUrl,
    apiKey: input.apiKey,
    customerId: customer.id,
    subscriptionId: ensured.openmeterSubscriptionId,
  });
}

function subscriptionNeedsAllowanceChange(input: {
  sub: KonnectSubscription;
  plan: KonnectPlan;
  targetPlanId: string;
}): boolean {
  if (input.sub.plan_id === input.targetPlanId && isUsableAllowancePlan(input.plan)) {
    return false;
  }
  return (
    input.sub.plan_id !== input.targetPlanId || !rateCardsHaveUsageDiscount(input.plan)
  );
}

async function loadPlanCached(
  cache: Map<string, KonnectPlan>,
  baseUrl: string,
  apiKey: string,
  planId: string,
): Promise<KonnectPlan | null> {
  const cached = cache.get(planId);
  if (cached) return cached;
  try {
    const plan = await getKonnectPlan(baseUrl, apiKey, planId);
    cache.set(planId, plan);
    return plan;
  } catch {
    return null;
  }
}

async function changeOneSub(input: {
  baseUrl: string;
  apiKey: string;
  apply: boolean;
  timing: SubscriptionChangeTiming;
  sub: KonnectSubscription;
  plan: KonnectPlan;
  targetPlanId: string;
}): Promise<"changed" | "skipped" | "error"> {
  if (!subscriptionNeedsAllowanceChange(input)) {
    return "skipped";
  }
  if (!input.apply) {
    console.log(
      `  [dry-run] would change sub ${input.sub.id} -> target plan ` +
        `(hasDiscount=${rateCardsHaveUsageDiscount(input.plan)})`,
    );
    return "changed";
  }
  try {
    await changeKonnectSubscription({
      baseUrl: input.baseUrl,
      apiKey: input.apiKey,
      subscriptionId: input.sub.id,
      customerId: input.sub.customer_id,
      planId: input.targetPlanId,
      timing: input.timing,
    });
    console.log(`  [change] sub ${input.sub.id} -> ${input.targetPlanId}`);
    return "changed";
  } catch (err) {
    console.error(
      `  [error] change sub ${input.sub.id}: ${err instanceof Error ? err.message : "failed"}`,
    );
    return "error";
  }
}

async function changeSubsOntoAllowancePlans(input: {
  baseUrl: string;
  apiKey: string;
  apply: boolean;
  timing: SubscriptionChangeTiming;
  targetPlanIdByKey: Map<string, string>;
  starterKeys: Set<string>;
}): Promise<{ changed: number; skipped: number; errors: number; eligible: number }> {
  const stats = { changed: 0, skipped: 0, errors: 0, eligible: 0 };
  const planCache = new Map<string, KonnectPlan>();
  const subscriptions = await listActiveKonnectSubscriptions(
    input.baseUrl,
    input.apiKey,
  );

  for (const sub of subscriptions) {
    if (!sub.plan_id) {
      stats.skipped += 1;
      continue;
    }
    const plan = await loadPlanCached(
      planCache,
      input.baseUrl,
      input.apiKey,
      sub.plan_id,
    );
    if (!plan) {
      stats.errors += 1;
      continue;
    }
    if (!input.starterKeys.has(plan.key)) {
      continue;
    }
    const targetPlanId = input.targetPlanIdByKey.get(plan.key);
    if (!targetPlanId) {
      stats.skipped += 1;
      continue;
    }
    stats.eligible += 1;
    const result = await changeOneSub({
      baseUrl: input.baseUrl,
      apiKey: input.apiKey,
      apply: input.apply,
      timing: input.timing,
      sub,
      plan,
      targetPlanId,
    });
    stats[statsKeyForChangeResult(result)] += 1;
  }

  return stats;
}

async function syncAllStarters(input: {
  baseUrl: string;
  apiKey: string;
  apply: boolean;
  clientId?: string;
}): Promise<{
  targetPlanIdByKey: Map<string, string>;
  starterKeys: Set<string>;
}> {
  const starterRows = await loadStarterRows(
    input.clientId ? [input.clientId.trim()] : undefined,
  );
  console.log(`[fix-starter-allowance] starter plans in DB: ${starterRows.length}`);

  const targetPlanIdByKey = new Map<string, string>();
  const starterKeys = new Set<string>();

  for (const row of starterRows) {
    const synced = await syncStarterWithAllowance({
      baseUrl: input.baseUrl,
      apiKey: input.apiKey,
      row,
      apply: input.apply,
    });
    starterKeys.add(synced.planKey);
    if (synced.planId) {
      targetPlanIdByKey.set(synced.planKey, synced.planId);
    }
  }

  if (!input.apply) {
    for (const row of starterRows) {
      const key = buildOpenMeterPlanKey(row.clientId, row.id);
      starterKeys.add(key);
      if (row.openmeterPlanId?.trim()) {
        targetPlanIdByKey.set(key, row.openmeterPlanId.trim());
      }
    }
  }

  return { targetPlanIdByKey, starterKeys };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const { baseUrl, apiKey } = requireKonnectConfig();

  console.log(
    `[fix-starter-allowance] mode=${args.apply ? "APPLY" : "DRY-RUN"} timing=${args.timing}`,
  );
  console.log(
    `[fix-starter-allowance] default includedUsdMicros=${defaultStarterIncludedUsdMicros()}`,
  );

  if (args.ownerId) {
    await fixOwnerWallet({
      baseUrl,
      apiKey,
      ownerId: args.ownerId.trim(),
      apply: args.apply,
      timing: args.timing,
      preferredClientId: args.clientId,
    });
    if (!args.apply) {
      console.log("\n[fix-starter-allowance] re-run with --apply to execute");
    }
    return;
  }

  const { targetPlanIdByKey, starterKeys } = await syncAllStarters({
    baseUrl,
    apiKey,
    apply: args.apply,
    clientId: args.clientId,
  });

  if (args.apply && targetPlanIdByKey.size === 0) {
    throw new Error("No published Starter plan ids available after sync");
  }

  const subStats = await changeSubsOntoAllowancePlans({
    baseUrl,
    apiKey,
    apply: args.apply,
    timing: args.timing,
    targetPlanIdByKey,
    starterKeys,
  });

  // Konnect's global /subscriptions index often omits active rows (GET-by-id
  // still works). Fall back to per-owner cancel+ensure only when the list path
  // found no eligible Starter subscriptions at all.
  if (subStats.eligible === 0 && subStats.errors === 0) {
    console.log(
      "\n[fix-starter-allowance] global subscription list found no active " +
        "Starter rows to change — falling back to owner-wallet migration",
    );
    const ownerIds = await listOwnerIdsForFix(args.clientId);
    console.log(
      `[fix-starter-allowance] owner wallets to fix: ${ownerIds.length}`,
    );
    for (const ownerId of ownerIds) {
      await fixOwnerWallet({
        baseUrl,
        apiKey,
        ownerId,
        apply: args.apply,
        timing: args.timing,
        preferredClientId: args.clientId,
      });
    }
  }

  console.log(
    `\n[fix-starter-allowance] done changed=${subStats.changed} ` +
      `skipped=${subStats.skipped} errors=${subStats.errors}`,
  );
  if (!args.apply) {
    console.log("[fix-starter-allowance] re-run with --apply to execute");
  }
}

main()
  .catch((err) => {
    console.error("[fix-starter-allowance] fatal:", err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await closeDb();
  });
