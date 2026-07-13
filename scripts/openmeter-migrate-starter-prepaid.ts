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
import {
  getHostedOpenMeterUrl,
  isKonnectMeteringUrl,
  KONNECT_SETTLEMENT_MODE_CREDIT_THEN_INVOICE,
  normalizeKonnectMeteringUrl,
} from "../src/lib/openmeter/constants";
import { buildOpenMeterPlanKey } from "../src/lib/openmeter/plan-naming";
import { syncPlanToOpenMeter } from "../src/lib/openmeter/plans-sync";

type Args = {
  apply: boolean;
  clientId?: string;
  timing: "immediate" | "next_billing_cycle";
};

type KonnectPlan = {
  id: string;
  key: string;
  name?: string;
  status?: string;
  version?: number;
  settlement_mode?: string;
  currency?: string;
  billing_cadence?: string;
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
  settlement_mode?: string;
};

function parseArgs(argv: string[]): Args {
  const args: Args = {
    apply: false,
    timing: "immediate",
  };

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === "--apply") {
      args.apply = true;
      continue;
    }
    if (token === "--dry-run") {
      args.apply = false;
      continue;
    }
    if (token === "--client-id") {
      args.clientId = argv[++i]?.trim();
      if (!args.clientId) {
        throw new Error("--client-id requires a value");
      }
      continue;
    }
    if (token === "--timing") {
      const value = argv[++i]?.trim();
      if (value !== "immediate" && value !== "next_billing_cycle") {
        throw new Error("--timing must be immediate or next_billing_cycle");
      }
      args.timing = value;
      continue;
    }
    if (token === "--help" || token === "-h") {
      console.log(usage());
      process.exit(0);
    }
    throw new Error(`Unknown argument: ${token}\n\n${usage()}`);
  }

  return args;
}

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
  let parsed: unknown = null;
  if (text) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = text;
    }
  }
  if (!response.ok) {
    throw new Error(
      `Konnect ${method} ${path} failed [${response.status}]: ${text.slice(0, 800)}`,
    );
  }
  return parsed as T;
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
  if (rateCardsHaveUsageDiscount(plan)) {
    return true;
  }
  if (plan.settlement_mode !== KONNECT_SETTLEMENT_MODE_CREDIT_THEN_INVOICE) {
    return true;
  }
  return false;
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
    if (items.length < 100) {
      break;
    }
    page += 1;
  }
  return out;
}

async function getPlan(
  baseUrl: string,
  apiKey: string,
  planId: string,
): Promise<KonnectPlan> {
  return konnectFetch<KonnectPlan>(baseUrl, apiKey, "GET", `/plans/${planId}`);
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
}): Promise<{ current: KonnectSubscription; next: KonnectSubscription }> {
  return konnectFetch(input.baseUrl, input.apiKey, "POST", `/subscriptions/${input.subscriptionId}/change`, {
    customer: { id: input.customerId },
    plan: { id: input.planId },
    timing: input.timing,
  });
}

async function loadStarterRows(clientId?: string) {
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

  /** planKey -> target prepaid plan id */
  const targetPlanIdByKey = new Map<string, string>();
  let plansPublished = 0;
  let plansAlreadyOk = 0;
  let dbUpdated = 0;

  for (const row of starterRows) {
    const planKey = buildOpenMeterPlanKey(row.clientId, row.id);
    let targetId = row.openmeterPlanId?.trim() || null;
    let targetPlan: KonnectPlan | null = null;

    if (targetId) {
      try {
        targetPlan = await getPlan(baseUrl, apiKey, targetId);
      } catch (err) {
        console.warn(
          `[warn] ${row.clientId}: stored openmeterPlanId=${targetId} not readable: ${
            err instanceof Error ? err.message : err
          }`,
        );
        targetId = null;
        targetPlan = null;
      }
    }

    if (targetPlan && !planNeedsPrepaidRepublish(targetPlan) && targetPlan.status === "active") {
      targetPlanIdByKey.set(planKey, targetPlan.id);
      plansAlreadyOk += 1;
      console.log(
        `[plan-ok] ${row.clientId} key=${planKey} plan=${targetPlan.id} v${targetPlan.version ?? "?"}`,
      );
      continue;
    }

    if (!args.apply) {
      console.log(
        `[dry-run] would sync+publish prepaid Starter for ${row.clientId} key=${planKey}` +
          (targetPlan ? ` (current=${targetPlan.id} hasDiscount=${rateCardsHaveUsageDiscount(targetPlan)})` : ""),
      );
      // Still record intended key so subscription dry-run can mention it.
      if (targetId) {
        targetPlanIdByKey.set(planKey, `pending:${planKey}`);
      }
      continue;
    }

    const sync = await syncPlanToOpenMeter(row.id);
    if (!sync.ok || !sync.openmeterPlanId) {
      throw new Error(
        `syncPlanToOpenMeter failed for ${row.clientId}/${row.id}: ${sync.error ?? "no plan id"}`,
      );
    }

    let published = await getPlan(baseUrl, apiKey, sync.openmeterPlanId);
    if (planNeedsPrepaidRepublish(published) || published.status !== "active") {
      // sync may have updated an old draft path; force a clean prepaid version.
      published = await publishPrepaidPlanVersion(baseUrl, apiKey, published);
      await db
        .update(plans)
        .set({
          openmeterPlanId: published.id,
          openmeterPlanVersion: published.version ?? null,
          lastSyncedAt: new Date().toISOString(),
          syncError: null,
        })
        .where(eq(plans.id, row.id));
      dbUpdated += 1;
    } else if (row.openmeterPlanId !== published.id) {
      await db
        .update(plans)
        .set({
          openmeterPlanId: published.id,
          openmeterPlanVersion: published.version ?? null,
          lastSyncedAt: new Date().toISOString(),
          syncError: null,
        })
        .where(eq(plans.id, row.id));
      dbUpdated += 1;
    }

    targetPlanIdByKey.set(planKey, published.id);
    plansPublished += 1;
    console.log(
      `[plan] ${row.clientId} -> ${published.id} v${published.version ?? "?"} key=${planKey} discounts=${rateCardsHaveUsageDiscount(published)}`,
    );
  }

  const subscriptions = await listActiveSubscriptions(baseUrl, apiKey);
  const clientStarterKeys = new Set(
    starterRows.map((row) => buildOpenMeterPlanKey(row.clientId, row.id)),
  );

  console.log(
    `[migrate-starter-prepaid] active/scheduled subscriptions: ${subscriptions.length}`,
  );

  const planCache = new Map<string, KonnectPlan>();
  let changed = 0;
  let skipped = 0;
  let wouldChange = 0;
  let errors = 0;

  for (const sub of subscriptions) {
    if (!sub.plan_id) {
      skipped += 1;
      continue;
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

    // With --client-id, only touch that app's known Starter plan key(s).
    if (args.clientId && !knownStarterKey) {
      skipped += 1;
      continue;
    }

    // Without --client-id, migrate known starters + any discounted / mis-settled starter-like plans.
    if (!knownStarterKey && !hasDiscount && !wrongSettlement && !starterNamed) {
      skipped += 1;
      continue;
    }

    let targetPlanId = targetPlanIdByKey.get(plan.key);

    if (!targetPlanId || targetPlanId.startsWith("pending:")) {
      if (!args.apply) {
        if (hasDiscount || wrongSettlement || plan.status !== "active") {
          wouldChange += 1;
          console.log(
            `[dry-run] would publish prepaid ${plan.key} and change sub ${sub.id} ` +
              `(customer=${sub.customer_id}, from=${sub.plan_id})`,
          );
        } else if (knownStarterKey) {
          // Target will be the synced plan after --apply; still report if on stale id.
          wouldChange += 1;
          console.log(
            `[dry-run] would ensure prepaid ${plan.key} and change sub ${sub.id} ` +
              `(customer=${sub.customer_id}, from=${sub.plan_id})`,
          );
        } else {
          skipped += 1;
        }
        continue;
      }

      if (hasDiscount || wrongSettlement || plan.status !== "active") {
        const published = await publishPrepaidPlanVersion(baseUrl, apiKey, plan);
        targetPlanId = published.id;
        targetPlanIdByKey.set(plan.key, published.id);
        planCache.set(published.id, published);
        plansPublished += 1;
        console.log(
          `[plan] key=${plan.key} -> ${published.id} v${published.version ?? "?"}`,
        );
      } else {
        targetPlanId = plan.id;
        targetPlanIdByKey.set(plan.key, plan.id);
      }
    }

    if (!targetPlanId || targetPlanId.startsWith("pending:") || sub.plan_id === targetPlanId) {
      skipped += 1;
      continue;
    }

    if (!args.apply) {
      wouldChange += 1;
      console.log(
        `[dry-run] would change sub ${sub.id} customer=${sub.customer_id} ` +
          `${sub.plan_id} -> ${targetPlanId} (key=${plan.key})`,
      );
      continue;
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
      changed += 1;
      console.log(
        `[changed] ${sub.id} -> ${result.next.id} plan=${result.next.plan_id} customer=${sub.customer_id}`,
      );
    } catch (err) {
      errors += 1;
      console.error(
        `[fail] sub ${sub.id} customer=${sub.customer_id}: ${
          err instanceof Error ? err.message : err
        }`,
      );
    }
  }

  console.log(
    `[migrate-starter-prepaid] done plansPublished=${plansPublished} plansAlreadyOk=${plansAlreadyOk} ` +
      `dbUpdated=${dbUpdated} changed=${changed} wouldChange=${wouldChange} skipped=${skipped} errors=${errors}`,
  );

  if (!args.apply) {
    console.log("[migrate-starter-prepaid] re-run with --apply to execute");
  }
  if (errors > 0) {
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
