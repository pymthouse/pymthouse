import { and, eq, inArray } from "drizzle-orm";

import { db } from "@/db/index";
import { developerApps, plans } from "@/db/schema";
import { calendarMonthBoundsUtc } from "@/lib/billing-utils";
import {
  getHostedAdminClient,
  isHostedAdminClientAvailable,
} from "@/lib/openmeter/admin-client";
import {
  resolveOpenMeterBillingIdentity,
  type ResolvedBillingIdentity,
} from "@/lib/openmeter/billing-identity";
import { NETWORK_FEE_USD_MICROS_METER } from "@/lib/openmeter/constants";
import { buildOwnerMeterSubjects } from "@/lib/openmeter/customer-key";
import {
  ensureOpenMeterCustomer,
  ensureOpenMeterCustomerForAppUser,
  listOwnedPublicClientIds,
} from "@/lib/openmeter/customers";
import { getTrialCreditBalance } from "@/lib/openmeter/entitlements";
import {
  isOwnerStarterPlanKey,
  ownerStarterIncludedUsdMicros,
} from "@/lib/openmeter/owner-starter-key";
import { buildOpenMeterPlanKey } from "@/lib/openmeter/plan-naming";
import { defaultStarterIncludedUsdMicros } from "@/lib/starter-default-plan-display";
import {
  getPrimaryOpenMeterSubscriptionForAppUser,
  resolveLocalPlanIdFromOpenMeterSubscription,
} from "@/lib/openmeter/subscription-read";
import { meterRowValueToBigInt } from "@/lib/openmeter/usage-read";

function parsePositiveMicros(raw: string | null | undefined): bigint | null {
  if (!raw?.trim()) return null;
  try {
    const value = BigInt(raw.trim());
    return value > 0n ? value : null;
  } catch {
    return null;
  }
}

/** Included usage discount for a local plan row (starter falls back to env default). */
export function includedDiscountUsdMicrosForPlan(
  plan: Pick<typeof plans.$inferSelect, "includedUsdMicros" | "isStarterDefault">,
): bigint | null {
  const fromPlan = parsePositiveMicros(plan.includedUsdMicros);
  if (fromPlan != null) return fromPlan;
  if (plan.isStarterDefault) {
    return parsePositiveMicros(defaultStarterIncludedUsdMicros());
  }
  return null;
}

async function querySubjectsUsedUsdMicros(
  subjects: string[],
  start: string,
  end: string,
): Promise<bigint> {
  if (!isHostedAdminClientAvailable()) {
    return 0n;
  }
  const unique = [...new Set(subjects.map((s) => s.trim()).filter(Boolean))];
  if (unique.length === 0) {
    return 0n;
  }
  const client = getHostedAdminClient();
  try {
    const result = await client.meters.query(NETWORK_FEE_USD_MICROS_METER, {
      windowSize: "MONTH",
      from: new Date(start),
      to: new Date(end),
      subject: unique,
    });
    let used = 0n;
    for (const row of result.data || []) {
      used += meterRowValueToBigInt(row.value);
    }
    return used;
  } catch {
    return 0n;
  }
}

/**
 * Owner wallets may subscribe to any owned app's Starter plan. Resolve the
 * local plan by openmeterPlanId or plan key across that owner's apps.
 */
async function resolveOwnerLocalPlanId(input: {
  ownerUserId: string;
  planId: string | null;
  planKey: string | null;
}): Promise<string | null> {
  const ownedAppIds = await db
    .select({ id: developerApps.id })
    .from(developerApps)
    .where(eq(developerApps.ownerId, input.ownerUserId));
  if (ownedAppIds.length === 0) return null;

  const clientIds = ownedAppIds.map((r) => r.id);
  if (input.planId) {
    const byOmId = await db
      .select({ id: plans.id })
      .from(plans)
      .where(
        and(
          inArray(plans.clientId, clientIds),
          eq(plans.openmeterPlanId, input.planId),
        ),
      )
      .limit(1);
    if (byOmId[0]?.id) return byOmId[0].id;
  }

  if (!input.planKey) return null;
  const ownedPlans = await db
    .select({ id: plans.id, clientId: plans.clientId })
    .from(plans)
    .where(inArray(plans.clientId, clientIds));
  for (const plan of ownedPlans) {
    if (buildOpenMeterPlanKey(plan.clientId, plan.id) === input.planKey) {
      return plan.id;
    }
  }
  return null;
}

async function resolveSubscriptionWithPlanKey(subscription: {
  planKey: string | null;
  planId: string | null;
  id: string;
  status: string;
  activeFrom: string | null;
  activeTo: string | null;
}) {
  let planKey = subscription.planKey;
  if (!planKey && subscription.planId && isHostedAdminClientAvailable()) {
    try {
      const remote = await getHostedAdminClient().plans.get(subscription.planId);
      planKey = remote?.key?.trim() || null;
    } catch {
      planKey = null;
    }
  }
  return planKey ? { ...subscription, planKey } : subscription;
}

async function discountForLocalPlanId(localPlanId: string): Promise<bigint | null> {
  const rows = await db
    .select({
      includedUsdMicros: plans.includedUsdMicros,
      isStarterDefault: plans.isStarterDefault,
    })
    .from(plans)
    .where(eq(plans.id, localPlanId))
    .limit(1);
  return rows[0] ? includedDiscountUsdMicrosForPlan(rows[0]) : null;
}

export type PlanDiscountUsdMicros = {
  /** Plan's included usage discount for the current cycle (the granted total). */
  totalUsdMicros: bigint;
  /** Remaining discount after this cycle's usage. */
  remainingUsdMicros: bigint;
};

/**
 * Plan usage discount for the current calendar month, for the customer's
 * primary active subscription: both the included total (granted) and the
 * remaining amount after usage. Zero when no discount applies.
 */
export async function getPlanDiscountUsdMicros(input: {
  clientId: string;
  externalUserId: string;
  /** Pre-resolved billing identity — avoids a duplicate DB lookup when the caller already has it. */
  identity?: ResolvedBillingIdentity;
}): Promise<PlanDiscountUsdMicros> {
  const zero: PlanDiscountUsdMicros = {
    totalUsdMicros: 0n,
    remainingUsdMicros: 0n,
  };
  if (!isHostedAdminClientAvailable()) {
    return zero;
  }

  const identity =
    input.identity ??
    (await resolveOpenMeterBillingIdentity({
      clientId: input.clientId,
      externalUserId: input.externalUserId,
    }));

  const subscription = await getPrimaryOpenMeterSubscriptionForAppUser({
    clientId: identity.publicClientId,
    externalUserId: input.externalUserId,
  });
  if (!subscription) {
    return zero;
  }

  const subscriptionForLookup = await resolveSubscriptionWithPlanKey(subscription);

  // Platform Owner Starter — discount is env/config, not a Neon plans row.
  if (
    identity.isOwner &&
    isOwnerStarterPlanKey(subscriptionForLookup.planKey)
  ) {
    const discount = parsePositiveMicros(ownerStarterIncludedUsdMicros());
    if (discount == null || discount <= 0n) {
      return zero;
    }
    return {
      totalUsdMicros: discount,
      remainingUsdMicros: await remainingDiscountAfterUsage({
        identity,
        input,
        discount,
      }),
    };
  }

  let localPlanId = await resolveLocalPlanIdFromOpenMeterSubscription(
    identity.developerAppId,
    subscriptionForLookup,
  );

  // Owner wallets on a paid / legacy per-app plan — look up across owned apps.
  if (!localPlanId && identity.isOwner && identity.ownerUserId) {
    localPlanId = await resolveOwnerLocalPlanId({
      ownerUserId: identity.ownerUserId,
      planId: subscriptionForLookup.planId,
      planKey: subscriptionForLookup.planKey,
    });
  }

  let discount: bigint | null = null;
  if (localPlanId) {
    discount = await discountForLocalPlanId(localPlanId);
  } else if (subscriptionForLookup.planKey?.toLowerCase().includes("starter")) {
    // Fail closed for unmapped non-Starter keys (including other pymthouse_* plans).
    discount = parsePositiveMicros(defaultStarterIncludedUsdMicros());
  }

  if (discount == null || discount <= 0n) {
    return zero;
  }

  return {
    totalUsdMicros: discount,
    remainingUsdMicros: await remainingDiscountAfterUsage({
      identity,
      input,
      discount,
    }),
  };
}

/**
 * Remaining plan usage discount for the current calendar month, for the
 * customer's primary active subscription. Zero when no discount or exhausted.
 */
export async function getRemainingPlanDiscountUsdMicros(input: {
  clientId: string;
  externalUserId: string;
  /** Pre-resolved billing identity — avoids a duplicate DB lookup when the caller already has it. */
  identity?: ResolvedBillingIdentity;
}): Promise<bigint> {
  return (await getPlanDiscountUsdMicros(input)).remainingUsdMicros;
}

async function remainingDiscountAfterUsage(input: {
  identity: ResolvedBillingIdentity;
  input: { clientId: string; externalUserId: string };
  discount: bigint;
}): Promise<bigint> {
  const { identity, discount } = input;
  const client = getHostedAdminClient();
  if (identity.isOwner && identity.ownerUserId) {
    await ensureOpenMeterCustomerForAppUser({
      client,
      clientId: input.input.clientId,
      externalUserId: input.input.externalUserId,
    });
  } else {
    await ensureOpenMeterCustomer(client, identity.customerKey);
  }

  const cycle = calendarMonthBoundsUtc(new Date());
  const usageSubjects =
    identity.isOwner && identity.ownerUserId
      ? buildOwnerMeterSubjects(
          identity.ownerUserId,
          [
            identity.publicClientId,
            ...(await listOwnedPublicClientIds(identity.ownerUserId)),
          ],
        )
      : [identity.customerKey];

  const used = await querySubjectsUsedUsdMicros(
    usageSubjects,
    cycle.start,
    cycle.end,
  );

  return used >= discount ? 0n : discount - used;
}

export type SpendableAllowanceDetails = {
  /** Spendable now: prepaid credits + remaining plan usage discount. */
  spendableUsdMicros: string;
  /** Granted total for the cycle: the plan's included usage discount. */
  grantedUsdMicros: string;
  /** Remaining plan usage discount only (excludes prepaid credits). */
  remainingPlanDiscountUsdMicros: string;
};

/**
 * Spendable allowance for mint/signer gates: prepaid credits + remaining
 * plan usage discount for the current cycle. Also returns the plan's included
 * discount total (granted) and remaining plan discount for the cycle.
 */
export async function getSpendableAllowanceDetails(input: {
  clientId: string;
  externalUserId: string;
  /** Skip a Neon round-trip when the caller already resolved billing identity. */
  identity?: ResolvedBillingIdentity;
}): Promise<SpendableAllowanceDetails | null> {
  if (!isHostedAdminClientAvailable()) {
    return null;
  }

  // Resolve the billing identity once and share it across both lookups so the
  // webhook balance gate performs a single Neon identity round-trip (#248).
  const identity =
    input.identity ??
    (await resolveOpenMeterBillingIdentity({
      clientId: input.clientId,
      externalUserId: input.externalUserId,
    }));

  const [credits, discount] = await Promise.all([
    getTrialCreditBalance({
      clientId: input.clientId,
      externalUserId: input.externalUserId,
      identity,
    }),
    getPlanDiscountUsdMicros({ ...input, identity }),
  ]);

  const creditMicros = BigInt(credits?.balanceUsdMicros ?? "0");
  return {
    spendableUsdMicros: (creditMicros + discount.remainingUsdMicros).toString(),
    grantedUsdMicros: discount.totalUsdMicros.toString(),
    remainingPlanDiscountUsdMicros: discount.remainingUsdMicros.toString(),
  };
}

/** Allowance shape for `GET .../usage/balance` (plan discount, not trial credit). */
export async function getUsageBalanceAllowance(input: {
  clientId: string;
  externalUserId: string;
  identity?: ResolvedBillingIdentity;
}): Promise<{
  balanceUsdMicros: string;
  consumedUsdMicros: string;
  lifetimeGrantedUsdMicros: string;
  hasAccess: boolean;
  remainingUsdMicros: string;
} | null> {
  const details = await getSpendableAllowanceDetails(input);
  if (!details) {
    return null;
  }

  const granted = BigInt(details.grantedUsdMicros);
  const remaining = BigInt(details.remainingPlanDiscountUsdMicros);
  const consumed = granted > remaining ? granted - remaining : 0n;
  const spendable = BigInt(details.spendableUsdMicros);

  return {
    // Meter remaining / granted is the plan included-discount cycle.
    balanceUsdMicros: remaining.toString(),
    remainingUsdMicros: remaining.toString(),
    lifetimeGrantedUsdMicros: granted.toString(),
    consumedUsdMicros: consumed.toString(),
    hasAccess: spendable > 0n,
  };
}

export async function getSpendableUsdMicros(input: {
  clientId: string;
  externalUserId: string;
  /** Skip a Neon round-trip when the caller already resolved billing identity. */
  identity?: ResolvedBillingIdentity;
}): Promise<string | null> {
  const details = await getSpendableAllowanceDetails(input);
  return details?.spendableUsdMicros ?? null;
}
