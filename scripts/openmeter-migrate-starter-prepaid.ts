/**
 * Migrate Konnect Starter subscriptions onto prepaid-only plan versions
 * (no rate_cards.discounts.usage, settlement_mode=credit_then_invoice).
 *
 * Each app end-user remains a distinct OpenMeter customer
 * (`client_id:external_user_id`). This only changes the plan version their
 * subscription points at so usage settles against prepaid credits.
 *
 * Usage:
 *   # Preview (default)
 *   DATABASE_URL=… OPENMETER_URL=… OPENMETER_API_KEY=… \
 *     npx tsx scripts/openmeter-migrate-starter-prepaid.ts
 *
 *   # Apply
 *   … npx tsx scripts/openmeter-migrate-starter-prepaid.ts --apply
 *
 *   # One app only
 *   … npx tsx scripts/openmeter-migrate-starter-prepaid.ts --client-id app_xxx --apply
 */
import "./load-env-first";
import { and, eq } from "drizzle-orm";
import { closeDb, db } from "../src/db/index";
import { plans } from "../src/db/schema";
import { KONNECT_SETTLEMENT_MODE_CREDIT_THEN_INVOICE } from "../src/lib/openmeter/constants";
import { buildOpenMeterPlanKey } from "../src/lib/openmeter/plan-naming";
import { syncPlanToOpenMeter } from "../src/lib/openmeter/plans-sync";
import {
  changeKonnectSubscription,
  getKonnectPlan,
  konnectFetch,
  listActiveKonnectSubscriptions,
  parseSubscriptionTiming,
  rateCardsHaveUsageDiscount,
  requireKonnectConfig,
  takeArgValue,
  type KonnectPlan,
  type KonnectSubscription,
  type SubscriptionChangeTiming,
} from "./lib/openmeter-konnect-migrate";

type Args = {
  apply: boolean;
  clientId?: string;
  timing: SubscriptionChangeTiming;
};

type StarterRow = {
  id: string;
  clientId: string;
  openmeterPlanId: string | null;
  openmeterPlanVersion: number | null;
};

type PlanEnsureStats = {
  published: number;
  alreadyOk: number;
  dbUpdated: number;
};

type SubMigrateStats = {
  changed: number;
  skipped: number;
  wouldChange: number;
  errors: number;
  plansPublished: number;
};

function usage(): string {
  return [
    "openmeter-migrate-starter-prepaid",
    "",
    "Migrate active Konnect subscriptions onto prepaid-only Starter plan versions",
    "(strip discounts.usage; keep credit_then_invoice).",
    "",
    "Options:",
    "  --dry-run                 Preview only (default)",
    "  --apply                   Publish plans + change subscriptions",
    "  --client-id <app_id>      Limit to one app's Starter plan key",
    "  --timing immediate|next_billing_cycle",
    "                            Subscription change timing (default: immediate)",
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

function stripUsageDiscountsFromPhases(
  phases: KonnectPlan["phases"],
): Array<Record<string, unknown>> {
  return (phases ?? []).map((phase) => ({
    key: phase.key ?? "default",
    name: phase.name ?? "Default",
    rate_cards: (phase.rate_cards ?? []).map((card) => {
      const next = { ...card };
      delete next.discounts;
      return next;
    }),
  }));
}

function planNeedsPrepaidRepublish(plan: KonnectPlan): boolean {
  return (
    rateCardsHaveUsageDiscount(plan) ||
    plan.settlement_mode !== KONNECT_SETTLEMENT_MODE_CREDIT_THEN_INVOICE
  );
}

function isUsablePrepaidPlan(plan: KonnectPlan): boolean {
  return plan.status === "active" && !planNeedsPrepaidRepublish(plan);
}

async function getPlan(
  baseUrl: string,
  apiKey: string,
  planId: string,
): Promise<KonnectPlan> {
  return getKonnectPlan(baseUrl, apiKey, planId);
}

async function publishPrepaidPlanVersion(
  baseUrl: string,
  apiKey: string,
  source: KonnectPlan,
): Promise<KonnectPlan> {
  const created = await konnectFetch<KonnectPlan>(baseUrl, apiKey, "POST", "/plans", {
    key: source.key,
    name: source.name ?? "pymthousestarter",
    currency: source.currency ?? "USD",
    billing_cadence: source.billing_cadence ?? "P1M",
    settlement_mode: KONNECT_SETTLEMENT_MODE_CREDIT_THEN_INVOICE,
    phases: stripUsageDiscountsFromPhases(source.phases),
  });
  return konnectFetch<KonnectPlan>(
    baseUrl,
    apiKey,
    "POST",
    `/plans/${created.id}/publish`,
  );
}

async function changeSubscription(input: {
  baseUrl: string;
  apiKey: string;
  subscriptionId: string;
  customerId: string;
  planId: string;
  timing: Args["timing"];
}): Promise<{ current?: KonnectSubscription; next?: KonnectSubscription }> {
  return changeKonnectSubscription(input);
}

async function loadStarterRows(clientId?: string): Promise<StarterRow[]> {
  const conditions = [
    eq(plans.isStarterDefault, true),
    eq(plans.status, "active"),
  ];
  if (clientId) {
    conditions.push(eq(plans.clientId, clientId));
  }
  return db
    .select({
      id: plans.id,
      clientId: plans.clientId,
      openmeterPlanId: plans.openmeterPlanId,
      openmeterPlanVersion: plans.openmeterPlanVersion,
    })
    .from(plans)
    .where(and(...conditions));
}

async function readStoredPlan(
  baseUrl: string,
  apiKey: string,
  row: StarterRow,
): Promise<KonnectPlan | null> {
  const targetId = row.openmeterPlanId?.trim() || null;
  if (!targetId) {
    return null;
  }
  try {
    return await getPlan(baseUrl, apiKey, targetId);
  } catch (err) {
    console.warn(
      `[warn] ${row.clientId}: stored openmeterPlanId=${targetId} not readable: ${
        err instanceof Error ? err.message : err
      }`,
    );
    return null;
  }
}

async function updateStarterOpenMeterPlan(
  rowId: string,
  published: KonnectPlan,
): Promise<void> {
  await db
    .update(plans)
    .set({
      openmeterPlanId: published.id,
      openmeterPlanVersion: published.version ?? null,
      lastSyncedAt: new Date().toISOString(),
      syncError: null,
    })
    .where(eq(plans.id, rowId));
}

async function ensurePrepaidStarterPlan(input: {
  baseUrl: string;
  apiKey: string;
  row: StarterRow;
  apply: boolean;
  targetPlanIdByKey: Map<string, string>;
  stats: PlanEnsureStats;
}): Promise<void> {
  const { baseUrl, apiKey, row, apply, targetPlanIdByKey, stats } = input;
  const planKey = buildOpenMeterPlanKey(row.clientId, row.id);
  const targetPlan = await readStoredPlan(baseUrl, apiKey, row);

  if (targetPlan && isUsablePrepaidPlan(targetPlan)) {
    targetPlanIdByKey.set(planKey, targetPlan.id);
    stats.alreadyOk += 1;
    console.log(
      `[plan-ok] ${row.clientId} key=${planKey} plan=${targetPlan.id} v${targetPlan.version ?? "?"}`,
    );
    return;
  }

  if (!apply) {
    console.log(
      `[dry-run] would sync+publish prepaid Starter for ${row.clientId} key=${planKey}` +
        (targetPlan
          ? ` (current=${targetPlan.id} hasDiscount=${rateCardsHaveUsageDiscount(targetPlan)})`
          : ""),
    );
    if (row.openmeterPlanId?.trim()) {
      targetPlanIdByKey.set(planKey, `pending:${planKey}`);
    }
    return;
  }

  const sync = await syncPlanToOpenMeter(row.id);
  if (!sync.ok || !sync.openmeterPlanId) {
    throw new Error(
      `syncPlanToOpenMeter failed for ${row.clientId}/${row.id}: ${sync.error ?? "no plan id"}`,
    );
  }

  let published = await getPlan(baseUrl, apiKey, sync.openmeterPlanId);
  if (!isUsablePrepaidPlan(published)) {
    published = await publishPrepaidPlanVersion(baseUrl, apiKey, published);
  }
  if (row.openmeterPlanId !== published.id || !isUsablePrepaidPlan(published)) {
    await updateStarterOpenMeterPlan(row.id, published);
    stats.dbUpdated += 1;
  }

  targetPlanIdByKey.set(planKey, published.id);
  stats.published += 1;
  console.log(
    `[plan] ${row.clientId} -> ${published.id} v${published.version ?? "?"} key=${planKey} discounts=${rateCardsHaveUsageDiscount(published)}`,
  );
}

function shouldConsiderSubscription(input: {
  clientId?: string;
  knownStarterKey: boolean;
  hasDiscount: boolean;
  wrongSettlement: boolean;
  starterNamed: boolean;
}): boolean {
  if (input.clientId) {
    return input.knownStarterKey;
  }
  return (
    input.knownStarterKey ||
    input.hasDiscount ||
    input.wrongSettlement ||
    input.starterNamed
  );
}

async function resolveTargetPlanId(input: {
  baseUrl: string;
  apiKey: string;
  apply: boolean;
  plan: KonnectPlan;
  sub: KonnectSubscription;
  knownStarterKey: boolean;
  targetPlanIdByKey: Map<string, string>;
  planCache: Map<string, KonnectPlan>;
  stats: SubMigrateStats;
}): Promise<string | null> {
  const {
    baseUrl,
    apiKey,
    apply,
    plan,
    sub,
    knownStarterKey,
    targetPlanIdByKey,
    planCache,
    stats,
  } = input;

  let targetPlanId = targetPlanIdByKey.get(plan.key);
  if (targetPlanId && !targetPlanId.startsWith("pending:")) {
    return targetPlanId;
  }

  const needsPublish =
    rateCardsHaveUsageDiscount(plan) ||
    plan.settlement_mode !== KONNECT_SETTLEMENT_MODE_CREDIT_THEN_INVOICE ||
    plan.status !== "active";

  if (!apply) {
    if (needsPublish || knownStarterKey) {
      stats.wouldChange += 1;
      console.log(
        `[dry-run] would ${needsPublish ? "publish prepaid" : "ensure prepaid"} ${plan.key} and change sub ${sub.id} ` +
          `(customer=${sub.customer_id}, from=${sub.plan_id})`,
      );
    } else {
      stats.skipped += 1;
    }
    return null;
  }

  if (needsPublish) {
    const published = await publishPrepaidPlanVersion(baseUrl, apiKey, plan);
    targetPlanId = published.id;
    targetPlanIdByKey.set(plan.key, published.id);
    planCache.set(published.id, published);
    stats.plansPublished += 1;
    console.log(`[plan] key=${plan.key} -> ${published.id} v${published.version ?? "?"}`);
    return targetPlanId;
  }

  targetPlanIdByKey.set(plan.key, plan.id);
  return plan.id;
}

async function migrateOneSubscription(input: {
  baseUrl: string;
  apiKey: string;
  args: Args;
  sub: KonnectSubscription;
  clientStarterKeys: Set<string>;
  targetPlanIdByKey: Map<string, string>;
  planCache: Map<string, KonnectPlan>;
  stats: SubMigrateStats;
}): Promise<void> {
  const {
    baseUrl,
    apiKey,
    args,
    sub,
    clientStarterKeys,
    targetPlanIdByKey,
    planCache,
    stats,
  } = input;

  if (!sub.plan_id) {
    stats.skipped += 1;
    return;
  }

  let plan = planCache.get(sub.plan_id);
  if (!plan) {
    plan = await getPlan(baseUrl, apiKey, sub.plan_id);
    planCache.set(sub.plan_id, plan);
  }

  const knownStarterKey = clientStarterKeys.has(plan.key);
  const starterNamed = (plan.name ?? "").toLowerCase().includes("starter");
  const hasDiscount = rateCardsHaveUsageDiscount(plan);
  const wrongSettlement =
    plan.settlement_mode !== KONNECT_SETTLEMENT_MODE_CREDIT_THEN_INVOICE;

  if (
    !shouldConsiderSubscription({
      clientId: args.clientId,
      knownStarterKey,
      hasDiscount,
      wrongSettlement,
      starterNamed,
    })
  ) {
    stats.skipped += 1;
    return;
  }

  const targetPlanId = await resolveTargetPlanId({
    baseUrl,
    apiKey,
    apply: args.apply,
    plan,
    sub,
    knownStarterKey,
    targetPlanIdByKey,
    planCache,
    stats,
  });

  if (!targetPlanId || targetPlanId.startsWith("pending:") || sub.plan_id === targetPlanId) {
    if (targetPlanId && sub.plan_id === targetPlanId) {
      stats.skipped += 1;
    }
    return;
  }

  if (!args.apply) {
    stats.wouldChange += 1;
    console.log(
      `[dry-run] would change sub ${sub.id} customer=${sub.customer_id} ` +
        `${sub.plan_id} -> ${targetPlanId} (key=${plan.key})`,
    );
    return;
  }

  try {
    const result = await changeSubscription({
      baseUrl,
      apiKey,
      subscriptionId: sub.id,
      customerId: sub.customer_id,
      planId: targetPlanId,
      timing: args.timing,
    });
    stats.changed += 1;
    console.log(
      `[changed] ${sub.id} -> ${result.next?.id ?? targetPlanId} plan=${result.next?.plan_id ?? targetPlanId} customer=${sub.customer_id}`,
    );
  } catch (err) {
    stats.errors += 1;
    console.error(
      `[fail] sub ${sub.id} customer=${sub.customer_id}: ${
        err instanceof Error ? err.message : err
      }`,
    );
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const { baseUrl, apiKey } = requireKonnectConfig();

  console.log(
    `[migrate-starter-prepaid] mode=${args.apply ? "APPLY" : "DRY-RUN"} timing=${args.timing}` +
      (args.clientId ? ` clientId=${args.clientId}` : ""),
  );
  console.log(`[migrate-starter-prepaid] target=${baseUrl}`);

  const starterRows = await loadStarterRows(args.clientId);
  console.log(`[migrate-starter-prepaid] starter plans in DB: ${starterRows.length}`);

  const targetPlanIdByKey = new Map<string, string>();
  const planStats: PlanEnsureStats = { published: 0, alreadyOk: 0, dbUpdated: 0 };
  for (const row of starterRows) {
    await ensurePrepaidStarterPlan({
      baseUrl,
      apiKey,
      row,
      apply: args.apply,
      targetPlanIdByKey,
      stats: planStats,
    });
  }

  const subscriptions = await listActiveKonnectSubscriptions(baseUrl, apiKey);
  const clientStarterKeys = new Set(
    starterRows.map((row) => buildOpenMeterPlanKey(row.clientId, row.id)),
  );
  console.log(
    `[migrate-starter-prepaid] active/scheduled subscriptions: ${subscriptions.length}`,
  );

  const planCache = new Map<string, KonnectPlan>();
  const subStats: SubMigrateStats = {
    changed: 0,
    skipped: 0,
    wouldChange: 0,
    errors: 0,
    plansPublished: 0,
  };

  for (const sub of subscriptions) {
    await migrateOneSubscription({
      baseUrl,
      apiKey,
      args,
      sub,
      clientStarterKeys,
      targetPlanIdByKey,
      planCache,
      stats: subStats,
    });
  }

  console.log(
    `[migrate-starter-prepaid] done plansPublished=${planStats.published + subStats.plansPublished} ` +
      `plansAlreadyOk=${planStats.alreadyOk} dbUpdated=${planStats.dbUpdated} ` +
      `changed=${subStats.changed} wouldChange=${subStats.wouldChange} ` +
      `skipped=${subStats.skipped} errors=${subStats.errors}`,
  );

  if (!args.apply) {
    console.log("[migrate-starter-prepaid] re-run with --apply to execute");
  }
  if (subStats.errors > 0) {
    process.exit(1);
  }
}

main()
  .catch((err) => {
    console.error("[migrate-starter-prepaid] fatal:", err);
    process.exit(1);
  })
  .finally(async () => {
    await closeDb({ timeout: 5 });
  });
