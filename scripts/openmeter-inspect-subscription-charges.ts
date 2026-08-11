/**
 * Read-only: does a paid plan actually produce a collectable charge?
 *
 * Answers "is there anything to collect at all" before any collection-timing
 * work, by walking the four places the subscription fee can silently vanish:
 *
 *   1. Neon plan row      — `type` must be `subscription` and `price_amount` > 0,
 *                           otherwise plans-sync never emits a fee rate card.
 *   2. Published OM plan  — the synced version must carry a `flat` price card.
 *   3. Subscription       — it must sit on that plan version, not an older one.
 *   4. Gathering invoice  — the fee line must be there, above the Stripe floor.
 *
 * Usage:
 *   npx tsx scripts/openmeter-inspect-subscription-charges.ts \
 *     --client-id app_xxx --external-user-id eu_xxx
 *   npx tsx scripts/openmeter-inspect-subscription-charges.ts \
 *     --client-id app_xxx --external-user-id eu_xxx --json
 *
 * Exit codes:
 *   0 — a collectable charge exists (or the run was informational only)
 *   1 — no collectable charge, or a fatal failure
 */
import "./load-env-first";

import { eq } from "drizzle-orm";
import type { OpenMeter } from "@openmeter/sdk";

import { closeDb, db } from "../src/db/index";
import { plans } from "../src/db/schema";
import { MIN_INVOICE_USD_MICROS } from "../src/lib/billing/overage-limits";
import {
  gatheringTotalUsdMicros,
  resolveBillingCustomerId,
} from "../src/lib/billing/unbilled-debt";
import {
  getHostedAdminClient,
  isHostedAdminClientAvailable,
} from "../src/lib/openmeter/admin-client";
import { resolveOpenMeterBillingIdentity } from "../src/lib/openmeter/billing-identity";
import { getAppBillingConfig } from "../src/lib/openmeter/billing-profiles";
import { konnectMeteringV1Fetch } from "../src/lib/openmeter/konnect-admin-client";
import { parsePriceAmount } from "../src/lib/openmeter/plans-sync";
import {
  listOpenMeterSubscriptionsForCustomer,
  type OpenMeterSubscriptionView,
} from "../src/lib/openmeter/subscription-read";

type Args = {
  clientId: string;
  externalUserId: string;
  json: boolean;
};

function usage(): string {
  return [
    "openmeter-inspect-subscription-charges",
    "",
    "Check whether a paid plan produces a collectable OpenMeter charge.",
    "",
    "Options:",
    "  --client-id <app_… | developer_apps.id>   (required)",
    "  --external-user-id <id>                   (required)",
    "  --json                                    Print the raw report as JSON",
    "  --help",
  ].join("\n");
}

function parseArgs(argv: string[]): Args {
  let clientId = "";
  let externalUserId = "";
  let json = false;

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === "--client-id") {
      clientId = argv[++i]?.trim() ?? "";
      continue;
    }
    if (token === "--external-user-id") {
      externalUserId = argv[++i]?.trim() ?? "";
      continue;
    }
    if (token === "--json") {
      json = true;
      continue;
    }
    if (token === "--help") {
      console.log(usage());
      process.exit(0);
    }
    throw new Error(`Unknown argument: ${token}\n\n${usage()}`);
  }

  if (!clientId || !externalUserId) {
    throw new Error(`--client-id and --external-user-id are required\n\n${usage()}`);
  }
  return { clientId, externalUserId, json };
}

type RateCardView = {
  key: string | null;
  priceType: string | null;
  amount: string | null;
  paymentTerm: string | null;
  billingCadence: string | null;
};

type RemotePlanView = {
  id: string;
  key: string | null;
  version: number | null;
  rateCards: RateCardView[];
};

type LocalPlanView = {
  id: string;
  name: string;
  type: string;
  status: string;
  priceAmount: string;
  billingCycle: string;
  openmeterPlanId: string | null;
  openmeterPlanVersion: number | null;
  lastSyncedAt: string | null;
  /** True when plans-sync would emit a `subscription_fee` rate card. */
  feeCardExpected: boolean;
  remote: RemotePlanView | null;
};

type InvoiceLineView = {
  name: string;
  total: string;
};

type InvoiceView = {
  id: string;
  status: string;
  total: string;
  totalUsdMicros: string | null;
  lines: InvoiceLineView[];
};

/** Most recent invoices to report; older history is noise for this check. */
const INVOICE_DISPLAY_LIMIT = 20;
const INVOICE_PAGE_SIZE = 100;

function readRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

function readString(value: unknown): string | null {
  if (typeof value === "string") return value.trim() || null;
  if (typeof value === "number") return String(value);
  return null;
}

/**
 * Konnect and the self-hosted SDK disagree on casing (`rate_cards` vs
 * `rateCards`, `payment_term` vs `paymentTerm`), so read both spellings.
 */
function readRateCards(plan: unknown): RateCardView[] {
  const phases = readRecord(plan)?.phases;
  if (!Array.isArray(phases)) return [];

  const out: RateCardView[] = [];
  for (const rawPhase of phases) {
    const phase = readRecord(rawPhase);
    if (!phase) continue;
    const cards = phase.rateCards ?? phase.rate_cards;
    if (!Array.isArray(cards)) continue;

    for (const rawCard of cards) {
      const card = readRecord(rawCard);
      if (!card) continue;
      const price = readRecord(card.price);
      out.push({
        key: readString(card.key),
        priceType: readString(price?.type),
        amount: readString(price?.amount),
        paymentTerm:
          readString(price?.paymentTerm) ??
          readString(price?.payment_term) ??
          readString(card.paymentTerm) ??
          readString(card.payment_term),
        billingCadence:
          readString(card.billingCadence) ?? readString(card.billing_cadence),
      });
    }
  }
  return out;
}

function isFlatFeeCard(card: RateCardView): boolean {
  return card.priceType === "flat";
}

async function fetchRemotePlan(
  client: OpenMeter,
  planId: string,
): Promise<RemotePlanView | null> {
  try {
    const plan = await client.plans.get(planId);
    if (!plan?.id) return null;
    return {
      id: plan.id,
      key: plan.key?.trim() || null,
      version: typeof plan.version === "number" ? plan.version : null,
      rateCards: readRateCards(plan),
    };
  } catch {
    return null;
  }
}

async function loadLocalPlans(
  client: OpenMeter,
  developerAppId: string,
): Promise<LocalPlanView[]> {
  const rows = await db.select().from(plans).where(eq(plans.clientId, developerAppId));

  const out: LocalPlanView[] = [];
  for (const row of rows) {
    out.push({
      id: row.id,
      name: row.name,
      type: row.type,
      status: row.status,
      priceAmount: row.priceAmount,
      billingCycle: row.billingCycle,
      openmeterPlanId: row.openmeterPlanId,
      openmeterPlanVersion: row.openmeterPlanVersion,
      lastSyncedAt: row.lastSyncedAt,
      feeCardExpected:
        row.type === "subscription" && parsePriceAmount(row.priceAmount) !== "0",
      remote: row.openmeterPlanId
        ? await fetchRemotePlan(client, row.openmeterPlanId)
        : null,
    });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

function mapInvoice(raw: unknown): InvoiceView | null {
  const inv = readRecord(raw);
  const id = readString(inv?.id);
  if (!inv || !id) return null;

  const total = readRecord(inv.totals)?.total;
  const rawLines = Array.isArray(inv.lines) ? inv.lines : [];
  return {
    id,
    status: readString(inv.status) ?? "unknown",
    total: readString(total) ?? "0",
    totalUsdMicros: gatheringTotalUsdMicros(total)?.toString() ?? null,
    lines: rawLines.map((line) => {
      const lineTotal = readRecord(readRecord(line)?.totals)?.total;
      return {
        name: readString(readRecord(line)?.name) ?? "Charge",
        total: readString(lineTotal) ?? "0",
      };
    }),
  };
}

/**
 * `/v3/openmeter/billing/invoices` rejects a `customer.id` filter, so read the
 * `/metering/v1` route the runtime debt lookup uses and keep the SDK as a
 * fallback for self-hosted OpenMeter.
 *
 * That route silently ignores `page[number]` and `filter[status][eq]` and
 * defaults to oldest-first, so `order`/`orderBy` are the only way to reach the
 * recent invoices that matter here.
 */
async function loadInvoices(
  client: OpenMeter,
  customerId: string,
): Promise<InvoiceView[]> {
  const params = new URLSearchParams();
  params.set("filter[customer.id][eq]", customerId);
  params.set("order", "DESC");
  params.set("orderBy", "createdAt");
  params.set("page[size]", String(INVOICE_PAGE_SIZE));
  params.set("expand", "lines");

  try {
    const listed = await konnectMeteringV1Fetch<{ items?: unknown[] }>(
      `/billing/invoices?${params.toString()}`,
      { method: "GET" },
      "inspect-invoices",
    );
    // Invoice ids are ULIDs, so a lexicographic sort is newest-first.
    return (listed?.items ?? [])
      .map(mapInvoice)
      .filter((inv): inv is InvoiceView => inv !== null)
      .sort((a, b) => b.id.localeCompare(a.id))
      .slice(0, INVOICE_DISPLAY_LIMIT);
  } catch {
    const listed = await client.billing.invoices.list({
      customers: [customerId],
      page: 1,
      pageSize: INVOICE_DISPLAY_LIMIT,
      order: "DESC",
      orderBy: "createdAt",
      expand: ["lines"],
    });
    return (listed?.items ?? [])
      .map(mapInvoice)
      .filter((inv): inv is InvoiceView => inv !== null);
  }
}

function printPlans(localPlans: LocalPlanView[]): void {
  console.log("\n[1/4] Neon plan rows + [2/4] published OpenMeter rate cards");
  if (localPlans.length === 0) {
    console.log("  (none — this app has no plan rows)");
    return;
  }

  for (const plan of localPlans) {
    console.log(
      `\n  ${plan.name} (${plan.id})` +
        `\n    type=${plan.type} status=${plan.status} price=${plan.priceAmount} ` +
        `cycle=${plan.billingCycle}` +
        `\n    feeCardExpected=${plan.feeCardExpected} ` +
        `omPlanId=${plan.openmeterPlanId ?? "none"} ` +
        `omVersion=${plan.openmeterPlanVersion ?? "none"} ` +
        `lastSyncedAt=${plan.lastSyncedAt ?? "never"}`,
    );

    if (!plan.openmeterPlanId) {
      console.log("    remote: not synced");
      continue;
    }
    if (!plan.remote) {
      console.log(`    remote: plan ${plan.openmeterPlanId} NOT FOUND in OpenMeter`);
      continue;
    }
    console.log(
      `    remote: key=${plan.remote.key ?? "none"} version=${plan.remote.version ?? "none"}`,
    );
    if (plan.remote.rateCards.length === 0) {
      console.log("      (no rate cards)");
    }
    for (const card of plan.remote.rateCards) {
      console.log(
        `      - ${card.key ?? "?"}: price=${card.priceType ?? "none"} ` +
          `amount=${card.amount ?? "none"} term=${card.paymentTerm ?? "none"} ` +
          `cadence=${card.billingCadence ?? "none"}`,
      );
    }
    const hasFlat = plan.remote.rateCards.some(isFlatFeeCard);
    if (plan.feeCardExpected && !hasFlat) {
      console.log("      !! expected a flat fee card here, published plan has none");
    }
  }
}

function localPlanLabel(local: LocalPlanView | undefined): string {
  if (!local) return "UNMAPPED — likely a stale plan version";
  return `${local.name} (${local.id})`;
}

function printSubscriptions(
  customerId: string | null,
  subscriptions: OpenMeterSubscriptionView[],
  localPlans: LocalPlanView[],
): void {
  console.log("\n[3/4] Subscriptions on the billing customer");
  if (!customerId) {
    console.log("  no OpenMeter customer resolved — nothing can be billed");
    return;
  }
  if (subscriptions.length === 0) {
    console.log(`  customerId=${customerId}: no subscriptions`);
    return;
  }
  for (const sub of subscriptions) {
    const local = localPlans.find((p) => p.openmeterPlanId === sub.planId);
    console.log(
      `  ${sub.id} status=${sub.status} planId=${sub.planId ?? "none"} ` +
        `planKey=${sub.planKey ?? "none"}` +
        `\n    activeFrom=${sub.activeFrom ?? "none"} activeTo=${sub.activeTo ?? "none"}` +
        `\n    localPlan=${localPlanLabel(local)}`,
    );
  }
}

function printInvoices(invoices: InvoiceView[]): void {
  console.log("\n[4/4] Most recent invoices on the billing customer");
  if (invoices.length === 0) {
    console.log("  (none)");
    return;
  }
  for (const inv of invoices) {
    console.log(
      `  ${inv.id} status=${inv.status} total=${inv.total} ` +
        `(${inv.totalUsdMicros ?? "?"} usd micros)`,
    );
    for (const line of inv.lines) {
      console.log(`    - ${line.name}: ${line.total}`);
    }
  }
}

function printSubscriptionVerdict(
  subscriptions: OpenMeterSubscriptionView[],
  localPlans: LocalPlanView[],
): void {
  const liveSubs = subscriptions.filter((sub) =>
    ["active", "trialing", "scheduled"].includes(sub.status.toLowerCase()),
  );
  const feeBearingSubs = liveSubs.filter((sub) =>
    localPlans.some(
      (plan) =>
        plan.openmeterPlanId === sub.planId &&
        (plan.remote?.rateCards ?? []).some(isFlatFeeCard),
    ),
  );
  if (liveSubs.length === 0) {
    console.log("  no live subscription — nothing is accruing a subscription fee");
    return;
  }
  if (feeBearingSubs.length === 0) {
    console.log(
      `  ${liveSubs.length} live subscription(s), none on a plan version that carries a ` +
        "flat fee card — no subscription fee can accrue",
    );
    return;
  }
  console.log(
    `  live fee-bearing subscription(s): ${feeBearingSubs.map((s) => s.id).join(", ")}`,
  );
}

function printGatheringVerdict(
  gathering: InvoiceView[],
  collectable: boolean,
): void {
  if (gathering.length === 0) {
    console.log(
      "  no gathering invoice — OpenMeter has accrued nothing for this customer, " +
        "so there is no charge any collection trigger could raise",
    );
    return;
  }
  if (collectable) {
    console.log(
      `  a gathering invoice is at or above the ${MIN_INVOICE_USD_MICROS} usd micros ` +
        "Stripe floor — forcing collection would raise a real invoice",
    );
    return;
  }
  console.log(
    `  a gathering invoice exists but sits below the ${MIN_INVOICE_USD_MICROS} usd micros ` +
      "Stripe floor — forcing collection would be skipped as uncollectable",
  );
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  if (!isHostedAdminClientAvailable()) {
    console.error("OPENMETER_URL / OPENMETER_API_KEY are not configured.");
    process.exitCode = 1;
    return;
  }

  const client = getHostedAdminClient();
  const identity = await resolveOpenMeterBillingIdentity({
    clientId: args.clientId,
    externalUserId: args.externalUserId,
  });
  const billingConfig = await getAppBillingConfig(identity.developerAppId);
  const billingMode = billingConfig?.billingMode ?? "owner_rollup";

  console.log(
    `\nidentity: developerAppId=${identity.developerAppId} ` +
      `publicClientId=${identity.publicClientId} ` +
      `customerKey=${identity.customerKey} isOwner=${identity.isOwner}` +
      `\nbillingMode=${billingMode} ` +
      `(custom invoicing / settlement applies only when merchant)`,
  );

  const localPlans = await loadLocalPlans(client, identity.developerAppId);
  printPlans(localPlans);

  const customerId = await resolveBillingCustomerId({
    clientId: args.clientId,
    externalUserId: args.externalUserId,
  });
  const subscriptions = customerId
    ? await listOpenMeterSubscriptionsForCustomer(client, customerId)
    : [];
  printSubscriptions(customerId, subscriptions, localPlans);

  const invoices = customerId ? await loadInvoices(client, customerId) : [];
  printInvoices(invoices);

  const gathering = invoices.filter((inv) => inv.status.toLowerCase() === "gathering");
  const collectable = gathering.some(
    (inv) =>
      inv.totalUsdMicros != null && BigInt(inv.totalUsdMicros) >= MIN_INVOICE_USD_MICROS,
  );

  console.log("\nverdict");
  printSubscriptionVerdict(subscriptions, localPlans);
  printGatheringVerdict(gathering, collectable);

  if (args.json) {
    console.log(
      `\n${JSON.stringify(
        {
          identity,
          billingMode,
          customerId,
          plans: localPlans,
          subscriptions,
          invoices,
        },
        null,
        2,
      )}`,
    );
  }

  if (!collectable) {
    process.exitCode = 1;
  }
}

main()
  .catch((err) => {
    console.error("[openmeter-inspect-subscription-charges] fatal:", err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await closeDb({ timeout: 5 });
  });
