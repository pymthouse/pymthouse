import { plans } from "@/db/schema";
import { calendarMonthBoundsUtc } from "@/lib/billing-utils";
import {
  getHostedAdminClient,
  isHostedAdminClientAvailable,
} from "@/lib/openmeter/admin-client";
import {
  ownerCostRailUserId,
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
  findOpenMeterPlanByKey,
  readUsageDiscountUsdMicrosFromPlanBody,
} from "@/lib/openmeter/owner-allowance-plan";
import {
  defaultStarterIncludedUsdMicros,
  parseIncludedUsdMicros,
} from "@/lib/starter-default-plan-display";
import { getPrimaryOpenMeterSubscriptionForAppUser } from "@/lib/openmeter/subscription-read";
import {
  ceilExactUsdMicrosSum,
  meterRowValueToNumber,
} from "@/lib/openmeter/usage-read";

/** Included usage discount for a local plan row (starter falls back to env default). */
export function includedDiscountUsdMicrosForPlan(
  plan: Pick<typeof plans.$inferSelect, "includedUsdMicros" | "isStarterDefault">,
): bigint | null {
  const fromPlan = parseIncludedUsdMicros(plan.includedUsdMicros);
  if (fromPlan != null) return fromPlan;
  if (plan.isStarterDefault) {
    return parseIncludedUsdMicros(defaultStarterIncludedUsdMicros());
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
    let usedExact = 0;
    for (const row of result.data || []) {
      usedExact += meterRowValueToNumber(row.value);
    }
    // Ceil once at the spendable-allowance boundary so fractional sub-micro
    // usage still burns at least 1 micro when any positive dust remains.
    return ceilExactUsdMicrosSum(usedExact);
  } catch {
    return 0n;
  }
}

/**
 * Included cycle allowance for the customer's current OpenMeter plan.
 * One active subscription → read that plan's rate-card `discounts.usage`.
 */
export async function includedDiscountFromOpenMeterSubscription(subscription: {
  planId: string | null;
  planKey: string | null;
}): Promise<bigint | null> {
  if (!isHostedAdminClientAvailable()) {
    return null;
  }
  const client = getHostedAdminClient();
  let planId = subscription.planId?.trim() || null;
  if (!planId && subscription.planKey?.trim()) {
    const found = await findOpenMeterPlanByKey(
      client,
      subscription.planKey.trim(),
    );
    planId = found?.id ?? null;
  }
  if (!planId) {
    return null;
  }
  try {
    const omPlan = await client.plans.get(planId);
    return parseIncludedUsdMicros(readUsageDiscountUsdMicrosFromPlanBody(omPlan));
  } catch {
    return null;
  }
}

export type PlanDiscountUsdMicros = {
  /** Plan's included usage discount for the current cycle (the granted total). */
  totalUsdMicros: bigint;
  /** Remaining discount after this cycle's usage. */
  remainingUsdMicros: bigint;
};

/**
 * Plan usage discount for the current calendar month from the customer's
 * primary OpenMeter subscription (session state): included total and remaining
 * after usage. Zero when the active plan has no usage discount.
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

  const discount =
    await includedDiscountFromOpenMeterSubscription(subscription);
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
  const ownerUserId = ownerCostRailUserId(identity);
  if (ownerUserId) {
    await ensureOpenMeterCustomerForAppUser({
      client,
      clientId: input.input.clientId,
      externalUserId: input.input.externalUserId,
    });
  } else {
    await ensureOpenMeterCustomer(client, identity.customerKey);
  }

  const cycle = calendarMonthBoundsUtc(new Date());
  const usageSubjects = ownerUserId
    ? buildOwnerMeterSubjects(ownerUserId, [
        identity.publicClientId,
        ...(await listOwnedPublicClientIds(ownerUserId)),
      ])
    : [
        identity.payerCustomerKey,
        ...(identity.legacyCompoundCustomerKey
          ? [identity.legacyCompoundCustomerKey]
          : []),
      ];

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
