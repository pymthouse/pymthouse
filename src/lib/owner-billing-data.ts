import { eq, inArray } from "drizzle-orm";
import { getServerSession } from "next-auth";
import type { OpenMeter } from "@openmeter/sdk";

import { db } from "@/db/index";
import { appBillingConfig, developerApps, oidcClients, plans } from "@/db/schema";
import { calendarMonthBoundsUtc } from "@/lib/billing-utils";
import { authOptions } from "@/lib/next-auth-options";
import {
  getHostedAdminClient,
  isHostedAdminClientAvailable,
} from "@/lib/openmeter/admin-client";
import {
  NETWORK_FEE_USD_MICROS_METER,
  requireOpenMeterForUsageReads,
  SIGNED_TICKET_COUNT_METER,
} from "@/lib/openmeter/constants";
import {
  getOwnerPrepaidCreditBalance,
  listOwnerCreditGrants,
  type CreditAllowanceSummary,
  type OwnerCreditGrant,
} from "@/lib/openmeter/credit-allowance-summary";
import {
  buildOpenMeterCustomerKey,
  buildOwnerCustomerKey,
  buildOwnerMeterSubjects,
} from "@/lib/openmeter/customer-key";
import {
  ensureOpenMeterCustomer,
  resolveCustomerSubjectKeys,
} from "@/lib/openmeter/customers";
import {
  defaultStarterIncludedUsdMicros,
  planDisplayNameWithStarter,
} from "@/lib/starter-default-plan-display";
import {
  isOwnerStarterPlanKey,
} from "@/lib/openmeter/owner-starter-key";
import { isOwnerPaidPlanKey } from "@/lib/openmeter/owner-paid-key";
import { resolvePlatformOwnerStarterPlanName } from "@/lib/billing/platform-owner-starter-default";
import { getOwnerSubscriptionTierByKey } from "@/lib/billing/owner-subscription-tiers";
import { applyFreeBillingProfileToCustomer } from "@/lib/openmeter/billing-profiles";
import {
  deriveOwnerPendingDowngrade,
  type OwnerPendingDowngrade,
} from "@/lib/openmeter/owner-starter-downgrade";
import { buildOpenMeterPlanKey } from "@/lib/openmeter/plan-naming";
import {
  isOpenMeterSubscriptionActive,
  listOpenMeterSubscriptionsForCustomer,
  resolveLocalPlanIdFromOpenMeterSubscription,
  type OpenMeterSubscriptionView,
} from "@/lib/openmeter/subscription-read";
import {
  dateKeyFromMeterWindow,
  meterRowValueToBigInt,
} from "@/lib/openmeter/usage-read";
import {
  buildLedgerEntries,
  type LedgerEntry,
} from "@/lib/billing/transactions-ledger";
import {
  listOwnerWalletInvoices,
  type TenantInvoiceDto,
} from "@/lib/openmeter/invoices";
import {
  listOwnerPaymentMethods,
  ownerHasChargeablePaymentMethod,
  OWNER_PAYMENT_METHOD_BUDGET_MS,
  type OwnerPaymentMethodListItem,
} from "@/lib/openmeter/owner-payment-method";
import {
  listOwnerStripeInvoices,
  type OwnerStripeInvoiceItem,
} from "@/lib/stripe/owner-platform-invoices";

/** Soft timeout for OpenMeter invoice list (Konnect /billing/invoices). */
const OWNER_INVOICE_LOOKUP_BUDGET_MS = 8_000;

export type OwnerBillingSubscriptionRow = {
  subscriptionId: string;
  status: string;
  customerKey: string;
  planName: string;
  localPlanId: string | null;
  openMeterPlanId: string | null;
  openMeterPlanKey: string | null;
  /** Null when billed on the shared owner wallet. */
  appPublicClientId: string | null;
  appName: string | null;
  /** Plan included usage discount for the cycle (USD micros). Null = no discount. */
  discountUsdMicros: string | null;
  usedUsdMicros: string;
  requestCount: number;
  /** max(0, used − discount); burns prepaid credits when > 0. */
  overageUsdMicros: string;
  activeFrom: string | null;
  activeTo: string | null;
};

export type OwnerBillingPayload = {
  userId: string;
  cycle: { start: string; end: string };
  creditAllowance: CreditAllowanceSummary | null;
  /** Every attached Stripe payment method (Plane A), default flagged. */
  paymentMethods: OwnerPaymentMethodListItem[];
  /**
   * True when Konnect/Stripe has a default payment method that can charge
   * plan fee and overage invoices — even if the listed methods array is empty
   * after a soft timeout.
   */
  hasChargeableBillingMethod: boolean;
  subscriptions: OwnerBillingSubscriptionRow[];
  /** Platform Owner Starter display name (admin-configurable). */
  ownerStarterPlanName: string;
  /**
   * Apps this owner owns, with how each one bills its end users. Every app
   * here rolls its network cost up to the platform subscription above.
   */
  ownedApps: Array<{
    id: string;
    name: string;
    billingMode: "owner_rollup" | "merchant";
  }>;
  /** Platform → developer invoices for the shared owner prepaid wallet. */
  invoices: TenantInvoiceDto[];
  /**
   * True when the OpenMeter invoice list soft-timed out or failed — UI should
   * not claim “no invoices yet” as if the account is empty.
   */
  invoicesDegraded: boolean;
  /**
   * Paid/open Stripe invoices on the owner platform customer (collection rail).
   * Merged with `invoices` in the Platform invoices UI.
   */
  stripeInvoices: OwnerStripeInvoiceItem[];
  /**
   * Chronological credit/usage/invoice history with a running prepaid balance.
   * Usage rows are derived from meter data — see transactions-ledger.
   */
  ledger: LedgerEntry[];
  openMeterConfigured: boolean;
  /**
   * First owned app id for app-scoped on-ramp APIs. Credits still settle on the
   * shared owner prepaid wallet via billing identity.
   */
  fundingClientId: string | null;
  /**
   * Scheduled end-of-cycle downgrade to Sandbox Starter (Paid remains active
   * until `effectiveAt`).
   */
  pendingDowngrade: OwnerPendingDowngrade | null;
};

export type OwnerBillingResult =
  | { ok: false; reason: "no_session" | "openmeter_unconfigured" }
  | { ok: true; data: OwnerBillingPayload };

type OwnedApp = {
  developerAppId: string;
  publicClientId: string;
  name: string;
  /**
   * owner_rollup — this app's end-user usage is paid by the owner's platform
   * plan. merchant — the Builder also bills their own end users via Connect,
   * but the owner still pays PymtHouse for the underlying network usage.
   */
  billingMode: "owner_rollup" | "merchant";
};

type CustomerCandidate = {
  customerKey: string;
  appPublicClientId: string | null;
  appName: string | null;
};

function parsePositiveMicros(raw: string | null | undefined): bigint | null {
  if (!raw?.trim()) return null;
  try {
    const value = BigInt(raw.trim());
    return value > 0n ? value : null;
  } catch {
    return null;
  }
}

function parseUsageDiscountValue(usage: unknown): bigint | null {
  if (typeof usage === "number") {
    return parsePositiveMicros(String(Math.trunc(usage)));
  }
  if (typeof usage === "string") {
    return parsePositiveMicros(usage);
  }
  return null;
}

function readUsageDiscountFromRateCard(card: unknown): bigint | null {
  if (!card || typeof card !== "object") return null;
  const discounts = (card as { discounts?: unknown }).discounts;
  if (!discounts || typeof discounts !== "object") return null;
  const usage =
    (discounts as { usage?: unknown }).usage ??
    (discounts as { Usage?: unknown }).Usage;
  return parseUsageDiscountValue(usage);
}

function readUsageDiscountFromPlanBody(plan: unknown): bigint | null {
  if (!plan || typeof plan !== "object") return null;
  const phases = (plan as { phases?: unknown }).phases;
  if (!Array.isArray(phases)) return null;

  let maxDiscount: bigint | null = null;
  for (const phase of phases) {
    if (!phase || typeof phase !== "object") continue;
    const rateCards =
      (phase as { rate_cards?: unknown; rateCards?: unknown }).rate_cards ??
      (phase as { rateCards?: unknown }).rateCards;
    if (!Array.isArray(rateCards)) continue;
    for (const card of rateCards) {
      const parsed = readUsageDiscountFromRateCard(card);
      if (parsed == null) continue;
      if (maxDiscount == null || parsed > maxDiscount) {
        maxDiscount = parsed;
      }
    }
  }
  return maxDiscount;
}

async function resolveDiscountUsdMicros(input: {
  client: OpenMeter;
  localPlanId: string | null;
  openMeterPlanId: string | null;
  isStarterDefault: boolean;
}): Promise<bigint | null> {
  if (input.localPlanId) {
    const rows = await db
      .select({
        includedUsdMicros: plans.includedUsdMicros,
        isStarterDefault: plans.isStarterDefault,
      })
      .from(plans)
      .where(eq(plans.id, input.localPlanId))
      .limit(1);
    const row = rows[0];
    if (row) {
      const fromPlan = parsePositiveMicros(row.includedUsdMicros);
      if (fromPlan != null) return fromPlan;
      if (row.isStarterDefault) {
        return parsePositiveMicros(defaultStarterIncludedUsdMicros());
      }
    }
  }

  if (input.openMeterPlanId) {
    try {
      const omPlan = await input.client.plans.get(input.openMeterPlanId);
      const fromOm = readUsageDiscountFromPlanBody(omPlan);
      if (fromOm != null) return fromOm;
    } catch {
      // Fall through — treat as no discount.
    }
  }

  if (input.isStarterDefault) {
    return parsePositiveMicros(defaultStarterIncludedUsdMicros());
  }
  return null;
}

async function querySubjectCycleUsage(input: {
  client: OpenMeter;
  subjects: string[];
  start: string;
  end: string;
}): Promise<{ usedUsdMicros: bigint; requestCount: number }> {
  const subjects = [...new Set(input.subjects.map((s) => s.trim()).filter(Boolean))];
  if (subjects.length === 0) {
    return { usedUsdMicros: 0n, requestCount: 0 };
  }

  const baseQuery = {
    windowSize: "MONTH" as const,
    from: new Date(input.start),
    to: new Date(input.end),
    subject: subjects,
  };

  try {
    const [feeResult, countResult] = await Promise.all([
      input.client.meters.query(NETWORK_FEE_USD_MICROS_METER, baseQuery),
      input.client.meters.query(SIGNED_TICKET_COUNT_METER, baseQuery),
    ]);

    let usedUsdMicros = 0n;
    for (const row of feeResult.data || []) {
      usedUsdMicros += meterRowValueToBigInt(row.value);
    }

    let requestCount = 0;
    for (const row of countResult.data || []) {
      const n = Number(row.value);
      if (Number.isFinite(n) && n > 0) {
        requestCount += Math.trunc(n);
      }
    }

    return { usedUsdMicros, requestCount };
  } catch (err) {
    console.warn(
      "owner-billing: meter query failed",
      subjects.join(","),
      err instanceof Error ? err.message : String(err),
    );
    return { usedUsdMicros: 0n, requestCount: 0 };
  }
}

/**
 * Konnect invoice totals arrive as decimal dollar strings ("5.00", "-2.5").
 * Convert to signed USD micros for the ledger; unparseable totals become 0
 * rather than breaking the page.
 */
function decimalDollarsToUsdMicros(raw: string | null | undefined): string {
  const trimmed = raw?.trim();
  if (!trimmed) return "0";
  const match = /^(-?)(\d*)(?:\.(\d*))?$/.exec(trimmed);
  if (!match) return "0";
  const [, sign, wholePart = "", fracPart = ""] = match;
  try {
    const whole = BigInt(wholePart || "0");
    const micros = BigInt((fracPart + "000000").slice(0, 6));
    const total = whole * 1_000_000n + micros;
    return (sign === "-" ? -total : total).toString();
  } catch {
    return "0";
  }
}

function invoiceTotalToUsdMicros(invoice: TenantInvoiceDto): string {
  return decimalDollarsToUsdMicros(invoice.totalAmount);
}

/**
 * Daily metered spend for the owner wallet, used to synthesize credit
 * consumption in the transactions ledger (OpenMeter has no consumption feed).
 */
async function querySubjectDailyUsage(input: {
  client: OpenMeter;
  subjects: string[];
  start: string;
  end: string;
}): Promise<Array<{ date: string; usedUsdMicros: string }>> {
  const subjects = [...new Set(input.subjects.map((s) => s.trim()).filter(Boolean))];
  if (subjects.length === 0) {
    return [];
  }

  try {
    const feeResult = await input.client.meters.query(NETWORK_FEE_USD_MICROS_METER, {
      windowSize: "DAY" as const,
      from: new Date(input.start),
      to: new Date(input.end),
      subject: subjects,
    });

    const byDay = new Map<string, bigint>();
    for (const row of feeResult.data || []) {
      const dateKey = dateKeyFromMeterWindow(row);
      if (!dateKey) continue;
      byDay.set(dateKey, (byDay.get(dateKey) ?? 0n) + meterRowValueToBigInt(row.value));
    }

    return [...byDay.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([date, used]) => ({ date, usedUsdMicros: used.toString() }));
  } catch (err) {
    console.warn(
      "owner-billing: daily meter query failed",
      subjects.join(","),
      err instanceof Error ? err.message : String(err),
    );
    return [];
  }
}

/** Wire + transitional subjects for shared-owner subscription usage. */
function buildOwnerWalletUsageSubjects(
  ownerUserId: string,
  ownedApps: OwnedApp[],
): string[] {
  return buildOwnerMeterSubjects(
    ownerUserId,
    ownedApps.map((app) => app.publicClientId),
  );
}

/**
 * Subjects to read for the owner wallet.
 *
 * Prefers `usageAttribution.subjectKeys` from the OpenMeter customer, because
 * that is the exact set OpenMeter's invoicing runs over — reading anything
 * wider shows usage the billing engine will never charge for. Falls back to the
 * transitional union only when the customer record cannot be read, so a lookup
 * failure degrades to the old behaviour rather than reporting zero.
 *
 * `classifyUsageAttributionConsistency` reports the gap between the two.
 * See docs/adr-owner-vs-app-billing.md.
 */
async function resolveOwnerWalletReadSubjects(input: {
  client: OpenMeter;
  ownerUserId: string;
  ownedApps: OwnedApp[];
}): Promise<string[]> {
  const attributed = await resolveCustomerSubjectKeys(
    input.client,
    buildOwnerCustomerKey(input.ownerUserId),
  );
  if (attributed.length > 0) {
    return attributed;
  }
  return buildOwnerWalletUsageSubjects(input.ownerUserId, input.ownedApps);
}

async function listOwnedApps(ownerUserId: string): Promise<OwnedApp[]> {
  const rows = await db
    .select({
      developerAppId: developerApps.id,
      name: developerApps.name,
      publicClientId: oidcClients.clientId,
      billingMode: appBillingConfig.billingMode,
    })
    .from(developerApps)
    .leftJoin(oidcClients, eq(developerApps.oidcClientId, oidcClients.id))
    .leftJoin(appBillingConfig, eq(appBillingConfig.clientId, developerApps.id))
    .where(eq(developerApps.ownerId, ownerUserId));

  return rows
    .map((row) => ({
      developerAppId: row.developerAppId,
      name: row.name,
      publicClientId: row.publicClientId?.trim() || row.developerAppId,
      billingMode:
        row.billingMode === "merchant"
          ? ("merchant" as const)
          : ("owner_rollup" as const),
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

function buildCustomerCandidates(
  ownerUserId: string,
  ownedApps: OwnedApp[],
): CustomerCandidate[] {
  const ownerKey = buildOwnerCustomerKey(ownerUserId);
  const legacyOwnerKey = `owner:${ownerUserId.trim()}`;
  const appCandidates = ownedApps.flatMap((app) => [
    {
      customerKey: buildOpenMeterCustomerKey(app.publicClientId, ownerUserId),
      appPublicClientId: app.publicClientId,
      appName: app.name,
    },
    {
      customerKey: buildOpenMeterCustomerKey(app.publicClientId, legacyOwnerKey),
      appPublicClientId: app.publicClientId,
      appName: app.name,
    },
  ]);

  const ownerCandidates: CustomerCandidate[] = [
    {
      customerKey: ownerKey,
      appPublicClientId: null,
      appName: null,
    },
  ];
  // Dual-read transitional legacy owner:{id} customer during migration.
  if (legacyOwnerKey !== ownerKey) {
    ownerCandidates.push({
      customerKey: legacyOwnerKey,
      appPublicClientId: null,
      appName: null,
    });
  }

  return [...ownerCandidates, ...appCandidates];
}

async function resolvePlanName(input: {
  localPlanId: string | null;
  planKey: string | null;
}): Promise<{ planName: string; isStarterDefault: boolean }> {
  if (input.localPlanId) {
    const rows = await db
      .select({
        name: plans.name,
        isStarterDefault: plans.isStarterDefault,
        isNetworkDefault: plans.isNetworkDefault,
      })
      .from(plans)
      .where(eq(plans.id, input.localPlanId))
      .limit(1);
    const row = rows[0];
    if (row) {
      return {
        planName: planDisplayNameWithStarter(row),
        isStarterDefault: row.isStarterDefault,
      };
    }
  }

  const key = input.planKey?.toLowerCase() ?? "";
  if (key.includes("starter") || isOwnerStarterPlanKey(input.planKey)) {
    return {
      planName: await resolvePlatformOwnerStarterPlanName(),
      isStarterDefault: true,
    };
  }
  if (isOwnerPaidPlanKey(input.planKey) && input.planKey) {
    const tier = await getOwnerSubscriptionTierByKey(input.planKey);
    return {
      planName: tier?.name?.trim() || "Owner Paid",
      isStarterDefault: false,
    };
  }
  return {
    planName: input.planKey?.trim() || "Subscription",
    isStarterDefault: false,
  };
}

async function loadPlanKeyToLocalId(
  clientIds: string[],
): Promise<Map<string, string>> {
  const index = new Map<string, string>();
  if (clientIds.length === 0) {
    return index;
  }
  const scopedPlans = await db
    .select({
      id: plans.id,
      clientId: plans.clientId,
    })
    .from(plans)
    .where(inArray(plans.clientId, clientIds));
  for (const plan of scopedPlans) {
    if (!plan.clientId) continue;
    index.set(buildOpenMeterPlanKey(plan.clientId, plan.id), plan.id);
  }
  return index;
}

/**
 * Resolve `fallback` on timeout or failure so first paint is never blocked.
 *
 * The fallback is indistinguishable from a genuine result, so callers that
 * need to know whether data is complete must pass `onDegraded`.
 */
function withSoftTimeout<T>(
  promise: Promise<T>,
  ms: number,
  fallback: T,
  label: string,
  onDegraded?: () => void,
): Promise<T> {
  return new Promise((resolve) => {
    const degrade = (value: T) => {
      onDegraded?.();
      resolve(value);
    };
    const timer = setTimeout(() => {
      console.warn(`owner-billing: ${label} timed out after ${ms}ms`);
      degrade(fallback);
    }, ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        console.warn(
          `owner-billing: ${label} failed`,
          err instanceof Error ? err.message : String(err),
        );
        degrade(fallback);
      },
    );
  });
}

async function mapSubscriptionRow(input: {
  client: OpenMeter;
  subscription: OpenMeterSubscriptionView;
  candidate: CustomerCandidate;
  cycle: { start: string; end: string };
  ownerUserId: string;
  ownedApps: OwnedApp[];
  planKeyToLocalId: Map<string, string>;
  /** Pre-resolved owner-wallet subjects; avoids a second OpenMeter lookup. */
  ownerWalletSubjects?: string[];
}): Promise<OwnerBillingSubscriptionRow> {
  const localPlanId = input.candidate.appPublicClientId
    ? await resolveLocalPlanIdFromOpenMeterSubscription(
        input.candidate.appPublicClientId,
        input.subscription,
      )
    : null;

  // Owner-wallet subscriptions may still map via plan key across owned apps.
  let resolvedLocalPlanId = localPlanId;
  if (!resolvedLocalPlanId && input.subscription.planKey) {
    resolvedLocalPlanId =
      input.planKeyToLocalId.get(input.subscription.planKey) ?? null;
  }

  const { planName, isStarterDefault } = await resolvePlanName({
    localPlanId: resolvedLocalPlanId,
    planKey: input.subscription.planKey,
  });

  const discountUsdMicros = await resolveDiscountUsdMicros({
    client: input.client,
    localPlanId: resolvedLocalPlanId,
    openMeterPlanId: input.subscription.planId,
    isStarterDefault,
  });

  const isSharedOwnerWallet = input.candidate.appPublicClientId == null;
  // Read the subjects OpenMeter actually bills for this customer, so the
  // figure shown matches the invoice it explains.
  const usageSubjects = isSharedOwnerWallet
    ? (input.ownerWalletSubjects ??
      (await resolveOwnerWalletReadSubjects({
        client: input.client,
        ownerUserId: input.ownerUserId,
        ownedApps: input.ownedApps,
      })))
    : [input.candidate.customerKey];

  const usage = await querySubjectCycleUsage({
    client: input.client,
    subjects: usageSubjects,
    start: input.cycle.start,
    end: input.cycle.end,
  });

  let overage = usage.usedUsdMicros;
  if (discountUsdMicros != null) {
    overage =
      usage.usedUsdMicros > discountUsdMicros
        ? usage.usedUsdMicros - discountUsdMicros
        : 0n;
  }

  return {
    subscriptionId: input.subscription.id,
    status: input.subscription.status,
    customerKey: input.candidate.customerKey,
    planName,
    localPlanId: resolvedLocalPlanId,
    openMeterPlanId: input.subscription.planId,
    openMeterPlanKey: input.subscription.planKey,
    appPublicClientId: input.candidate.appPublicClientId,
    appName: input.candidate.appName,
    discountUsdMicros: discountUsdMicros?.toString() ?? null,
    usedUsdMicros: usage.usedUsdMicros.toString(),
    requestCount: usage.requestCount,
    overageUsdMicros: overage.toString(),
    activeFrom: input.subscription.activeFrom,
    activeTo: input.subscription.activeTo,
  };
}

async function resolveCustomerIdForCandidate(input: {
  client: OpenMeter;
  candidate: CustomerCandidate;
}): Promise<string | null> {
  try {
    const isSharedOwnerWallet = input.candidate.appPublicClientId == null;
    if (isSharedOwnerWallet) {
      const customer = await ensureOpenMeterCustomer(
        input.client,
        input.candidate.customerKey,
      );
      return customer.id;
    }
    const listed = await input.client.customers.list({
      key: input.candidate.customerKey,
      page: 1,
      pageSize: 20,
    });
    const match = (listed?.items ?? []).find(
      (item) => item.key === input.candidate.customerKey,
    );
    return match?.id ?? null;
  } catch {
    return null;
  }
}

async function listActiveSubscriptionsForCustomer(input: {
  client: OpenMeter;
  customerId: string;
  customerKey: string;
}): Promise<OpenMeterSubscriptionView[]> {
  try {
    const listed = await listOpenMeterSubscriptionsForCustomer(
      input.client,
      input.customerId,
    );
    return listed.filter((item) => {
      if (isOpenMeterSubscriptionActive(item.status)) {
        return true;
      }
      // Keep canceled Owner Paid so pending-downgrade / resume-blocked UX can
      // see the paid plan when only a scheduled Starter successor is "active".
      return (
        (item.status || "").toLowerCase() === "canceled" &&
        isOwnerPaidPlanKey(item.planKey)
      );
    });
  } catch (err) {
    console.warn(
      "owner-billing: subscription list failed",
      input.customerKey,
      err instanceof Error ? err.message : String(err),
    );
    return [];
  }
}

/**
 * Active subscriptions for an owner with cycle usage toward plan discounts.
 * Used by Billing and the Usage dashboard summary.
 */
export async function listOwnerActiveSubscriptions(
  userId: string,
  options?: Readonly<{
    ownedApps?: OwnedApp[];
    ownerWalletSubjects?: string[];
  }>,
): Promise<OwnerBillingSubscriptionRow[]> {
  const trimmed = userId.trim();
  if (!trimmed) {
    return [];
  }
  if (!requireOpenMeterForUsageReads() || !isHostedAdminClientAvailable()) {
    return [];
  }

  const client = getHostedAdminClient();
  const cycleBounds = calendarMonthBoundsUtc(new Date());
  const cycle = { start: cycleBounds.start, end: cycleBounds.end };
  const ownedApps = options?.ownedApps ?? (await listOwnedApps(trimmed));
  const ownerWalletSubjects =
    options?.ownerWalletSubjects ??
    (await resolveOwnerWalletReadSubjects({
      client,
      ownerUserId: trimmed,
      ownedApps,
    }));
  const planKeyToLocalId = await loadPlanKeyToLocalId(
    ownedApps.map((app) => app.developerAppId),
  );
  const candidates = buildCustomerCandidates(trimmed, ownedApps);

  const perCandidate = await Promise.all(
    candidates.map(async (candidate) => {
      const customerId = await resolveCustomerIdForCandidate({ client, candidate });
      if (!customerId) {
        return [] as Array<{
          candidate: CustomerCandidate;
          subscription: OpenMeterSubscriptionView;
        }>;
      }
      const active = await listActiveSubscriptionsForCustomer({
        client,
        customerId,
        customerKey: candidate.customerKey,
      });
      return active.map((subscription) => ({ candidate, subscription }));
    }),
  );

  const seenSubscriptionIds = new Set<string>();
  const unique: Array<{
    candidate: CustomerCandidate;
    subscription: OpenMeterSubscriptionView;
  }> = [];
  for (const group of perCandidate) {
    for (const entry of group) {
      if (seenSubscriptionIds.has(entry.subscription.id)) continue;
      seenSubscriptionIds.add(entry.subscription.id);
      unique.push(entry);
    }
  }

  const subscriptions = await Promise.all(
    unique.map(({ candidate, subscription }) =>
      mapSubscriptionRow({
        client,
        subscription,
        candidate,
        cycle,
        ownerUserId: trimmed,
        ownedApps,
        planKeyToLocalId,
        ownerWalletSubjects,
      }),
    ),
  );

  subscriptions.sort((a, b) => {
    const usedA = BigInt(a.usedUsdMicros);
    const usedB = BigInt(b.usedUsdMicros);
    if (usedA !== usedB) return usedB > usedA ? 1 : -1;
    return a.planName.localeCompare(b.planName);
  });

  return subscriptions;
}

/**
 * Billing page payload for the signed-in app owner: prepaid credits +
 * active subscriptions with cycle usage toward any plan usage discount.
 */
export async function getOwnerBillingData(): Promise<OwnerBillingResult> {
  const session = await getServerSession(authOptions);
  const sessionUser = session?.user as Record<string, unknown> | undefined;
  const userId = sessionUser?.id as string | undefined;
  if (!userId?.trim()) {
    return { ok: false, reason: "no_session" };
  }

  const cycleBounds = calendarMonthBoundsUtc(new Date());
  const cycle = { start: cycleBounds.start, end: cycleBounds.end };

  if (!requireOpenMeterForUsageReads() || !isHostedAdminClientAvailable()) {
    return { ok: false, reason: "openmeter_unconfigured" };
  }

  const adminClient = getHostedAdminClient();
  // Resolve owned apps + wallet subjects once: subscriptions and daily usage
  // both read the same attributed subject set, and a second customer lookup
  // would be a wasted round trip with a consistency risk between the two.
  const ownedApps = await listOwnedApps(userId);
  const ownerWalletSubjects = await resolveOwnerWalletReadSubjects({
    client: adminClient,
    ownerUserId: userId,
    ownedApps,
  });
  // Invoices hit Konnect /billing/invoices (often multi-second). Soft-timeout so
  // first paint is not blocked when the invoice index is large or slow.
  const emptyInvoices = { items: [] as TenantInvoiceDto[] };
  // Grants and daily usage both move the prepaid balance, so a soft-timeout on
  // either leaves holes in the ledger's event chain and its running balances
  // cannot be trusted.
  let ledgerInputsDegraded = false;
  let invoicesDegraded = false;
  const [
    creditAllowance,
    paymentMethods,
    chargeableLookup,
    subscriptions,
    invoicesResult,
    stripeInvoices,
    creditGrants,
  ] = await Promise.all([
      getOwnerPrepaidCreditBalance(userId).catch((err) => {
        console.warn(
          "owner-billing: credit lookup failed",
          err instanceof Error ? err.message : String(err),
        );
        return null;
      }),
      withSoftTimeout(
        listOwnerPaymentMethods(userId),
        // Above the lookup's own budget, so its deadline fires first and we
        // keep whatever it resolved instead of falling back to empty.
        OWNER_PAYMENT_METHOD_BUDGET_MS + 1_000,
        [] as OwnerPaymentMethodListItem[],
        "payment method lookup",
      ),
      withSoftTimeout(
        ownerHasChargeablePaymentMethod(userId),
        OWNER_PAYMENT_METHOD_BUDGET_MS + 1_000,
        null as boolean | null,
        "payment method chargeability",
      ),
      withSoftTimeout(
        listOwnerActiveSubscriptions(userId, {
          ownedApps,
          ownerWalletSubjects,
        }),
        8_000,
        [] as OwnerBillingSubscriptionRow[],
        "subscription lookup",
      ),
      withSoftTimeout(
        listOwnerWalletInvoices({
          client: adminClient,
          ownerUserId: userId,
          page: 1,
          pageSize: 20,
        }),
        OWNER_INVOICE_LOOKUP_BUDGET_MS,
        emptyInvoices,
        "invoice lookup",
        () => {
          invoicesDegraded = true;
        },
      ),
      withSoftTimeout(
        listOwnerStripeInvoices(userId),
        OWNER_INVOICE_LOOKUP_BUDGET_MS,
        [] as OwnerStripeInvoiceItem[],
        "stripe invoice lookup",
        () => {
          invoicesDegraded = true;
        },
      ),
      withSoftTimeout(
        listOwnerCreditGrants(userId),
        2_500,
        [] as OwnerCreditGrant[],
        "credit grant lookup",
        () => {
          ledgerInputsDegraded = true;
        },
      ),
    ]);

  const dailyUsage = await withSoftTimeout(
    querySubjectDailyUsage({
      client: adminClient,
      subjects: ownerWalletSubjects,
      start: cycle.start,
      end: cycle.end,
    }),
    3_000,
    [] as Array<{ date: string; usedUsdMicros: string }>,
    "daily usage lookup",
    () => {
      ledgerInputsDegraded = true;
    },
  );

  // Allowance from the owner-wallet subscription (the one credits settle against).
  const ownerStarterPlanName = await resolvePlatformOwnerStarterPlanName();
  const { displaySubscriptions, pendingDowngrade } = deriveOwnerPendingDowngrade({
    subscriptions,
    starterPlanName: ownerStarterPlanName,
  });

  const walletSubscription =
    displaySubscriptions.find((row) => row.appPublicClientId == null) ??
    displaySubscriptions[0];

  // Once Starter is the live plan, restore the free hard-gate profile (skipped
  // when downgrade was only scheduled for next cycle).
  if (
    walletSubscription &&
    walletSubscription.appPublicClientId == null &&
    isOwnerStarterPlanKey(walletSubscription.openMeterPlanKey)
  ) {
    const status = walletSubscription.status.toLowerCase();
    if (status === "active" || status === "trialing" || !status) {
      await withSoftTimeout(
        (async () => {
          const customer = await ensureOpenMeterCustomer(
            adminClient,
            buildOwnerCustomerKey(userId),
          );
          await applyFreeBillingProfileToCustomer({
            client: adminClient,
            customerId: customer.id,
          });
        })(),
        5_000,
        undefined as void,
        "starter free billing profile reconcile",
      );
    }
  }

  const ledger = buildLedgerEntries({
    grants: creditGrants,
    dailyUsage,
    invoices: invoicesResult.items.map((invoice) => ({
      id: invoice.id,
      number: invoice.number,
      status: invoice.status,
      totalAmountUsdMicros: invoiceTotalToUsdMicros(invoice),
      issuedAt: invoice.issuedAt,
      periodStart: invoice.periodStart,
      periodEnd: invoice.periodEnd,
      invoiceType: invoice.invoiceType ?? null,
      lines: (invoice.lines ?? []).map((line) => ({
        id: line.id,
        name: line.name,
        description: line.description,
        totalAmountUsdMicros: decimalDollarsToUsdMicros(line.totalAmount),
        kind: line.kind,
      })),
    })),
    planIncludedUsdMicros: walletSubscription?.discountUsdMicros ?? null,
    endingCreditBalanceUsdMicros: creditAllowance?.balanceUsdMicros ?? null,
    inputsComplete: !ledgerInputsDegraded,
  });

  return {
    ok: true,
    data: {
      userId,
      cycle,
      creditAllowance,
      paymentMethods,
      hasChargeableBillingMethod: chargeableLookup === true,
      subscriptions: displaySubscriptions,
      ownerStarterPlanName,
      ownedApps: ownedApps.map((app) => ({
        id: app.developerAppId,
        name: app.name,
        billingMode: app.billingMode,
      })),
      invoices: invoicesResult.items,
      invoicesDegraded,
      stripeInvoices,
      ledger,
      openMeterConfigured: true,
      fundingClientId: ownedApps[0]?.developerAppId ?? null,
      pendingDowngrade,
    },
  };
}
