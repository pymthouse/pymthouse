import { eq } from "drizzle-orm";
import { getServerSession } from "next-auth";
import type { OpenMeter } from "@openmeter/sdk";

import { db } from "@/db/index";
import { developerApps, oidcClients, plans } from "@/db/schema";
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
  type CreditAllowanceSummary,
} from "@/lib/openmeter/credit-allowance-summary";
import {
  buildOpenMeterCustomerKey,
  buildOwnerCustomerKey,
  buildOwnerMeterSubjects,
} from "@/lib/openmeter/customer-key";
import { ensureOpenMeterCustomer } from "@/lib/openmeter/customers";
import {
  defaultStarterIncludedUsdMicros,
  planDisplayNameWithStarter,
} from "@/lib/starter-default-plan-display";
import { buildOpenMeterPlanKey } from "@/lib/openmeter/plan-naming";
import {
  isOpenMeterSubscriptionActive,
  listOpenMeterSubscriptionsForCustomer,
  resolveLocalPlanIdFromOpenMeterSubscription,
  type OpenMeterSubscriptionView,
} from "@/lib/openmeter/subscription-read";
import { meterRowValueToBigInt } from "@/lib/openmeter/usage-read";

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
  subscriptions: OwnerBillingSubscriptionRow[];
  openMeterConfigured: boolean;
};

export type OwnerBillingResult =
  | { ok: false; reason: "no_session" | "openmeter_unconfigured" }
  | { ok: true; data: OwnerBillingPayload };

type OwnedApp = {
  developerAppId: string;
  publicClientId: string;
  name: string;
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

async function listOwnedApps(ownerUserId: string): Promise<OwnedApp[]> {
  const rows = await db
    .select({
      developerAppId: developerApps.id,
      name: developerApps.name,
      publicClientId: oidcClients.clientId,
    })
    .from(developerApps)
    .leftJoin(oidcClients, eq(developerApps.oidcClientId, oidcClients.id))
    .where(eq(developerApps.ownerId, ownerUserId));

  return rows
    .map((row) => ({
      developerAppId: row.developerAppId,
      name: row.name,
      publicClientId: row.publicClientId?.trim() || row.developerAppId,
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

function buildCustomerCandidates(
  ownerUserId: string,
  ownedApps: OwnedApp[],
): CustomerCandidate[] {
  const ownerKey = buildOwnerCustomerKey(ownerUserId);
  const appCandidates = ownedApps.flatMap((app) => [
    {
      customerKey: buildOpenMeterCustomerKey(app.publicClientId, ownerUserId),
      appPublicClientId: app.publicClientId,
      appName: app.name,
    },
    {
      customerKey: buildOpenMeterCustomerKey(app.publicClientId, ownerKey),
      appPublicClientId: app.publicClientId,
      appName: app.name,
    },
  ]);

  return [
    {
      customerKey: ownerKey,
      appPublicClientId: null,
      appName: null,
    },
    ...appCandidates,
  ];
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
  if (key.includes("starter")) {
    return { planName: "Starter", isStarterDefault: true };
  }
  return {
    planName: input.planKey?.trim() || "Subscription",
    isStarterDefault: false,
  };
}

async function mapSubscriptionRow(input: {
  client: OpenMeter;
  subscription: OpenMeterSubscriptionView;
  candidate: CustomerCandidate;
  cycle: { start: string; end: string };
  ownerUserId: string;
  ownedApps: OwnedApp[];
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
    const allPlans = await db
      .select({
        id: plans.id,
        clientId: plans.clientId,
      })
      .from(plans);
    for (const plan of allPlans) {
      if (buildOpenMeterPlanKey(plan.clientId, plan.id) === input.subscription.planKey) {
        resolvedLocalPlanId = plan.id;
        break;
      }
    }
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
  const usageSubjects = isSharedOwnerWallet
    ? buildOwnerWalletUsageSubjects(input.ownerUserId, input.ownedApps)
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
    return listed.filter((item) => isOpenMeterSubscriptionActive(item.status));
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
  const ownedApps = await listOwnedApps(trimmed);
  const candidates = buildCustomerCandidates(trimmed, ownedApps);

  const seenSubscriptionIds = new Set<string>();
  const subscriptions: OwnerBillingSubscriptionRow[] = [];

  for (const candidate of candidates) {
    const customerId = await resolveCustomerIdForCandidate({ client, candidate });
    if (!customerId) continue;

    const active = await listActiveSubscriptionsForCustomer({
      client,
      customerId,
      customerKey: candidate.customerKey,
    });

    for (const subscription of active) {
      if (seenSubscriptionIds.has(subscription.id)) continue;
      seenSubscriptionIds.add(subscription.id);
      subscriptions.push(
        await mapSubscriptionRow({
          client,
          subscription,
          candidate,
          cycle,
          ownerUserId: trimmed,
          ownedApps,
        }),
      );
    }
  }

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

  const [creditAllowance, subscriptions] = await Promise.all([
    getOwnerPrepaidCreditBalance(userId).catch((err) => {
      console.warn(
        "owner-billing: credit lookup failed",
        err instanceof Error ? err.message : String(err),
      );
      return null;
    }),
    listOwnerActiveSubscriptions(userId),
  ]);

  return {
    ok: true,
    data: {
      userId,
      cycle,
      creditAllowance,
      subscriptions,
      openMeterConfigured: true,
    },
  };
}
