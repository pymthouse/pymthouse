/**
 * Fix Starter included-usage allowance and resubscribe onto plan versions that
 * carry Konnect rate-card `discounts.usage`.
 *
 * Context: prepaid-only Starter publishes (see openmeter-migrate-starter-prepaid)
 * left some live subscriptions on plan versions with no included allowance.
 * Mint/billing then see $0 spendable when prepaid credits are also empty.
 *
 * This script:
 *   1. Ensures each Starter row has `includedUsdMicros` (env default if missing)
 *   2. Syncs/publishes the plan to Konnect via syncPlanToOpenMeter
 *   3. Verifies the published plan has `discounts.usage`
 *   4. Moves subscriptions onto that plan version
 *        - default: POST /subscriptions/{id}/change
 *        - --owner-id: cancel active owner:{id} subs, then ensure Starter
 *
 * Usage:
 *   # Preview all Starter apps
 *   npx tsx scripts/openmeter-fix-starter-allowance.ts
 *
 *   # One owner wallet (recommended for Billing “no included usage”)
 *   npx tsx scripts/openmeter-fix-starter-allowance.ts \
 *     --owner-id 8112311f-634e-4602-984a-c8270da373e3
 *
 *   # Apply
 *   npx tsx scripts/openmeter-fix-starter-allowance.ts \
 *     --owner-id 8112311f-634e-4602-984a-c8270da373e3 --apply
 *
 *   # One app’s Starter + change all active subs on that plan key
 *   npx tsx scripts/openmeter-fix-starter-allowance.ts \
 *     --client-id app_xxx --apply
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
  getHostedOpenMeterUrl,
  isKonnectMeteringUrl,
  KONNECT_SETTLEMENT_MODE_CREDIT_THEN_INVOICE,
  normalizeKonnectMeteringUrl,
} from "../src/lib/openmeter/constants";
import { buildOwnerCustomerKey } from "../src/lib/openmeter/customer-key";
import { ensureOpenMeterCustomer } from "../src/lib/openmeter/customers";
import { buildOpenMeterPlanKey } from "../src/lib/openmeter/plan-naming";
import { syncPlanToOpenMeter } from "../src/lib/openmeter/plans-sync";
import { ensureStarterSubscriptionForAppUser } from "../src/lib/openmeter/starter-subscription";
import {
  isOpenMeterSubscriptionActive,
  listOpenMeterSubscriptionsForCustomer,
  type OpenMeterSubscriptionView,
} from "../src/lib/openmeter/subscription-read";
import { defaultStarterIncludedUsdMicros } from "../src/lib/starter-default-plan-display";

type Timing = "immediate" | "next_billing_cycle";

type Args = {
  apply: boolean;
  ownerId?: string;
  clientId?: string;
  timing: Timing;
};

type StarterRow = {
  id: string;
  clientId: string;
  includedUsdMicros: string | null;
  openmeterPlanId: string | null;
  openmeterPlanVersion: number | null;
};

type OwnedApp = {
  developerAppId: string;
  publicClientId: string;
  name: string;
};

type KonnectPlan = {
  id: string;
  key: string;
  name?: string;
  status?: string;
  version?: number;
  settlement_mode?: string;
  phases?: Array<{
    key?: string;
    name?: string;
    rate_cards?: Array<Record<string, unknown>>;
  }>;
};

type KonnectSubscription = {
  id: string;
  status: string;
  customer_id: string;
  plan_id?: string;
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
    "  --owner-id <users.id>     Fix shared owner:{id} wallet (cancel + recreate)",
    "  --client-id <app_id>      Limit to one app's Starter plan",
    "  --timing immediate|next_billing_cycle",
    "                            Cancel/change timing (default: immediate)",
  ].join("\n");
}

function takeValue(argv: string[], index: number, flag: string): string {
  const value = argv[index + 1]?.trim();
  if (!value) {
    throw new Error(`${flag} requires a value`);
  }
  return value;
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
        args.ownerId = takeValue(argv, i, token);
        i += 1;
        break;
      case "--client-id":
        args.clientId = takeValue(argv, i, token);
        i += 1;
        break;
      case "--timing": {
        const value = takeValue(argv, i, token);
        if (value !== "immediate" && value !== "next_billing_cycle") {
          throw new Error("--timing must be immediate|next_billing_cycle");
        }
        args.timing = value;
        i += 1;
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

function requireKonnectConfig(): { baseUrl: string; apiKey: string } {
  const rawUrl = getHostedOpenMeterUrl();
  const apiKey = process.env.OPENMETER_API_KEY?.trim();
  if (!apiKey) {
    throw new Error("OPENMETER_API_KEY is required");
  }
  if (!isKonnectMeteringUrl(rawUrl, apiKey)) {
    throw new Error(
      `This migration targets Konnect only (got OPENMETER_URL=${rawUrl})`,
    );
  }
  if (!isHostedAdminClientAvailable()) {
    throw new Error("OpenMeter admin client is not available");
  }
  return {
    baseUrl: normalizeKonnectMeteringUrl(rawUrl),
    apiKey,
  };
}

async function konnectFetch<T>(
  baseUrl: string,
  apiKey: string,
  method: string,
  path: string,
  body?: unknown,
): Promise<T> {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${apiKey}`,
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(
      `Konnect ${method} ${path} failed [${response.status}]: ${text.slice(0, 800)}`,
    );
  }
  if (!text) {
    return null as T;
  }
  try {
    return JSON.parse(text) as T;
  } catch {
    return text as T;
  }
}

function rateCardsHaveUsageDiscount(plan: KonnectPlan): boolean {
  for (const phase of plan.phases ?? []) {
    for (const card of phase.rate_cards ?? []) {
      const discounts = card.discounts;
      if (
        discounts &&
        typeof discounts === "object" &&
        (discounts as { usage?: unknown }).usage != null
      ) {
        return true;
      }
    }
  }
  return false;
}

function readUsageDiscountMicros(plan: KonnectPlan): string | null {
  for (const phase of plan.phases ?? []) {
    for (const card of phase.rate_cards ?? []) {
      const discounts = card.discounts;
      if (!discounts || typeof discounts !== "object") continue;
      const usage = (discounts as { usage?: unknown }).usage;
      if (usage == null) continue;
      return String(usage);
    }
  }
  return null;
}

function isUsableAllowancePlan(plan: KonnectPlan): boolean {
  return (
    plan.status === "active" &&
    rateCardsHaveUsageDiscount(plan) &&
    plan.settlement_mode === KONNECT_SETTLEMENT_MODE_CREDIT_THEN_INVOICE
  );
}

async function getPlan(
  baseUrl: string,
  apiKey: string,
  planId: string,
): Promise<KonnectPlan> {
  return konnectFetch<KonnectPlan>(baseUrl, apiKey, "GET", `/plans/${planId}`);
}

async function changeSubscription(input: {
  baseUrl: string;
  apiKey: string;
  subscriptionId: string;
  customerId: string;
  planId: string;
  timing: Timing;
}): Promise<void> {
  await konnectFetch(
    input.baseUrl,
    input.apiKey,
    "POST",
    `/subscriptions/${input.subscriptionId}/change`,
    {
      customer: { id: input.customerId },
      plan: { id: input.planId },
      timing: input.timing,
    },
  );
}

async function listActiveSubscriptions(
  baseUrl: string,
  apiKey: string,
): Promise<KonnectSubscription[]> {
  const out: KonnectSubscription[] = [];
  let page = 1;
  for (;;) {
    const body = await konnectFetch<{ data?: KonnectSubscription[] }>(
      baseUrl,
      apiKey,
      "GET",
      `/subscriptions?page=${page}&pageSize=100`,
    );
    const items = body.data ?? [];
    for (const item of items) {
      if (item.status === "active" || item.status === "scheduled") {
        out.push(item);
      }
    }
    if (items.length < 100) break;
    page += 1;
  }
  return out;
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
      openmeterPlanVersion: plans.openmeterPlanVersion,
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

async function ensureIncludedUsdMicros(row: StarterRow, apply: boolean): Promise<StarterRow> {
  const current = row.includedUsdMicros?.trim() || "";
  if (/^\d+$/.test(current) && BigInt(current) > 0n) {
    return row;
  }
  const next = defaultStarterIncludedUsdMicros();
  console.log(
    `  [db] ${row.clientId} starter ${row.id}: includedUsdMicros ` +
      `${current || "(empty)"} -> ${next}`,
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

async function syncStarterWithAllowance(input: {
  baseUrl: string;
  apiKey: string;
  row: StarterRow;
  apply: boolean;
}): Promise<{ planKey: string; planId: string | null; discount: string | null }> {
  const planKey = buildOpenMeterPlanKey(input.row.clientId, input.row.id);
  const row = await ensureIncludedUsdMicros(input.row, input.apply);

  if (!input.apply) {
    let discount: string | null = null;
    if (row.openmeterPlanId?.trim()) {
      try {
        const existing = await getPlan(
          input.baseUrl,
          input.apiKey,
          row.openmeterPlanId.trim(),
        );
        discount = readUsageDiscountMicros(existing);
        console.log(
          `  [dry-run] ${row.clientId} key=${planKey} current=${existing.id} ` +
            `v${existing.version ?? "?"} hasDiscount=${Boolean(discount)} ` +
            `discount=${discount ?? "none"} — would sync+publish allowance plan`,
        );
      } catch {
        console.log(
          `  [dry-run] ${row.clientId} key=${planKey} — would sync+publish allowance plan`,
        );
      }
    } else {
      console.log(
        `  [dry-run] ${row.clientId} key=${planKey} — would sync+publish allowance plan`,
      );
    }
    return { planKey, planId: row.openmeterPlanId, discount };
  }

  const sync = await syncPlanToOpenMeter(row.id);
  if (!sync.ok || !sync.openmeterPlanId) {
    throw new Error(
      `syncPlanToOpenMeter failed for ${row.clientId}/${row.id}: ${sync.error ?? "no plan id"}`,
    );
  }

  const published = await getPlan(input.baseUrl, input.apiKey, sync.openmeterPlanId);
  const discount = readUsageDiscountMicros(published);
  if (!isUsableAllowancePlan(published)) {
    throw new Error(
      `Published Starter ${published.id} key=${planKey} still missing discounts.usage ` +
        `(status=${published.status} settlement=${published.settlement_mode})`,
    );
  }

  console.log(
    `  [plan] ${row.clientId} -> ${published.id} v${published.version ?? "?"} ` +
      `key=${planKey} discount=${discount} settlement=${published.settlement_mode}`,
  );
  return { planKey, planId: published.id, discount };
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

async function fixOwnerWallet(input: {
  baseUrl: string;
  apiKey: string;
  ownerId: string;
  apply: boolean;
  timing: Timing;
}): Promise<void> {
  const apps = await listOwnedApps(input.ownerId);
  if (apps.length === 0) {
    console.log(`[owner] ${input.ownerId}: no owned apps — nothing to do`);
    return;
  }

  const ownerKey = buildOwnerCustomerKey(input.ownerId);
  console.log(
    `\n[owner] ${input.ownerId} key=${ownerKey} apps=${apps.length}`,
  );
  for (const app of apps) {
    console.log(`  app ${app.publicClientId} (${app.name})`);
  }

  const starters = await loadStarterRows(apps.map((a) => a.developerAppId));
  for (const row of starters) {
    await syncStarterWithAllowance({
      baseUrl: input.baseUrl,
      apiKey: input.apiKey,
      row,
      apply: input.apply,
    });
  }

  const client = getHostedAdminClient();
  const customer = await ensureOpenMeterCustomer(
    client,
    ownerKey,
    `Owner ${input.ownerId}`,
  );

  const active = (
    await listOpenMeterSubscriptionsForCustomer(client, customer.id)
  ).filter((sub) => isOpenMeterSubscriptionActive(sub.status));

  for (const sub of active) {
    console.log(
      `  [owner-sub] id=${sub.id} status=${sub.status} planKey=${sub.planKey ?? "?"}`,
    );
  }

  if (!input.apply) {
    console.log(
      `  [dry-run] would cancel ${active.length} sub(s) then ensure Starter via ${apps[0].publicClientId}`,
    );
    return;
  }

  for (const sub of active) {
    await cancelSubscription({
      client,
      subscriptionId: sub.id,
      timing: input.timing,
      dryRun: false,
      label: `owner wallet planKey=${sub.planKey ?? "?"}`,
    });
  }

  const firstApp = apps[0];
  const ensured = await ensureStarterSubscriptionForAppUser({
    clientId: firstApp.developerAppId,
    externalUserId: input.ownerId,
  });
  console.log(
    `  [ok] starter ensured sub=${ensured.openmeterSubscriptionId} ` +
      `created=${ensured.created} planId=${ensured.planId}`,
  );

  if (ensured.openmeterSubscriptionId) {
    const refreshed = await listOpenMeterSubscriptionsForCustomer(
      client,
      customer.id,
    );
    const current = refreshed.find((s) => s.id === ensured.openmeterSubscriptionId);
    const planId = current?.planId ?? null;
    if (planId) {
      const plan = await getPlan(input.baseUrl, input.apiKey, planId);
      console.log(
        `  [verify] sub plan=${plan.id} v${plan.version ?? "?"} ` +
          `discount=${readUsageDiscountMicros(plan) ?? "MISSING"} ` +
          `ok=${isUsableAllowancePlan(plan)}`,
      );
    }
  }
}

async function changeSubsOntoAllowancePlans(input: {
  baseUrl: string;
  apiKey: string;
  apply: boolean;
  timing: Timing;
  targetPlanIdByKey: Map<string, string>;
  starterKeys: Set<string>;
}): Promise<{ changed: number; skipped: number; errors: number }> {
  const stats = { changed: 0, skipped: 0, errors: 0 };
  const planCache = new Map<string, KonnectPlan>();
  const subscriptions = await listActiveSubscriptions(input.baseUrl, input.apiKey);

  for (const sub of subscriptions) {
    if (!sub.plan_id) {
      stats.skipped += 1;
      continue;
    }
    let plan = planCache.get(sub.plan_id);
    if (!plan) {
      try {
        plan = await getPlan(input.baseUrl, input.apiKey, sub.plan_id);
        planCache.set(sub.plan_id, plan);
      } catch (err) {
        stats.errors += 1;
        console.warn(
          `  [warn] sub ${sub.id}: cannot read plan ${sub.plan_id}: ${
            err instanceof Error ? err.message : err
          }`,
        );
        continue;
      }
    }

    const isStarterKey = input.starterKeys.has(plan.key);
    if (!isStarterKey) {
      continue;
    }

    const targetPlanId = input.targetPlanIdByKey.get(plan.key);
    if (!targetPlanId) {
      stats.skipped += 1;
      continue;
    }

    // Already on the target allowance plan version.
    if (sub.plan_id === targetPlanId && isUsableAllowancePlan(plan)) {
      stats.skipped += 1;
      continue;
    }

    // On some other allowance version of the same key — still move to canonical synced id.
    const needsChange =
      sub.plan_id !== targetPlanId || !rateCardsHaveUsageDiscount(plan);

    if (!needsChange) {
      stats.skipped += 1;
      continue;
    }

    if (!input.apply) {
      console.log(
        `  [dry-run] would change sub ${sub.id} customer=${sub.customer_id} ` +
          `${sub.plan_id} -> ${targetPlanId} (key=${plan.key}, hasDiscount=${rateCardsHaveUsageDiscount(plan)})`,
      );
      stats.changed += 1;
      continue;
    }

    try {
      await changeSubscription({
        baseUrl: input.baseUrl,
        apiKey: input.apiKey,
        subscriptionId: sub.id,
        customerId: sub.customer_id,
        planId: targetPlanId,
        timing: input.timing,
      });
      console.log(
        `  [change] sub ${sub.id} ${sub.plan_id} -> ${targetPlanId} (key=${plan.key})`,
      );
      stats.changed += 1;
    } catch (err) {
      stats.errors += 1;
      console.error(
        `  [error] change sub ${sub.id}: ${err instanceof Error ? err.message : err}`,
      );
    }
  }

  return stats;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const { baseUrl, apiKey } = requireKonnectConfig();

  console.log(
    `[fix-starter-allowance] mode=${args.apply ? "APPLY" : "DRY-RUN"} ` +
      `timing=${args.timing} target=${baseUrl}`,
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
    });
    if (!args.apply) {
      console.log("\n[fix-starter-allowance] re-run with --apply to execute");
    }
    return;
  }

  const starterRows = await loadStarterRows(
    args.clientId ? [args.clientId.trim()] : undefined,
  );
  console.log(`[fix-starter-allowance] starter plans in DB: ${starterRows.length}`);

  const targetPlanIdByKey = new Map<string, string>();
  const starterKeys = new Set<string>();

  for (const row of starterRows) {
    const synced = await syncStarterWithAllowance({
      baseUrl,
      apiKey,
      row,
      apply: args.apply,
    });
    starterKeys.add(synced.planKey);
    if (synced.planId && !synced.planId.startsWith("pending:")) {
      targetPlanIdByKey.set(synced.planKey, synced.planId);
    }
  }

  if (args.apply && targetPlanIdByKey.size === 0) {
    throw new Error("No published Starter plan ids available after sync");
  }

  // In dry-run, still map current ids so subscription preview can run.
  if (!args.apply) {
    for (const row of starterRows) {
      const key = buildOpenMeterPlanKey(row.clientId, row.id);
      starterKeys.add(key);
      if (row.openmeterPlanId?.trim()) {
        targetPlanIdByKey.set(key, row.openmeterPlanId.trim());
      }
    }
  }

  const subStats = await changeSubsOntoAllowancePlans({
    baseUrl,
    apiKey,
    apply: args.apply,
    timing: args.timing,
    targetPlanIdByKey,
    starterKeys,
  });

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
    console.error("[fix-starter-allowance] fatal:", err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await closeDb();
  });
