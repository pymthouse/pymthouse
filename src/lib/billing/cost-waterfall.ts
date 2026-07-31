/**
 * Cycle cost breakdown in the order usage is actually settled.
 *
 * Settlement is `credit_then_invoice`: the plan's included usage discount
 * absorbs spend first, prepaid credits cover what is left, and only the
 * remainder is invoiced to the attached Stripe payment method.
 *
 * Client-safe (no DB/Node imports) — rendered from both the server-side
 * billing page and the client-side usage dashboard.
 */

function parseMicros(raw: string | null | undefined): bigint {
  if (raw == null) return 0n;
  const trimmed = raw.trim();
  if (!trimmed) return 0n;
  try {
    const value = BigInt(trimmed);
    return value > 0n ? value : 0n;
  } catch {
    return 0n;
  }
}

function minBigInt(a: bigint, b: bigint): bigint {
  return a < b ? a : b;
}

export type CostWaterfallStep = {
  /** Amount this step absorbed for the cycle (USD micros). */
  appliedUsdMicros: string;
  /** Headroom left on this step, when the concept applies. */
  remainingUsdMicros: string | null;
  /** Capacity of this step (plan allowance), when the concept applies. */
  capacityUsdMicros: string | null;
};

export type CostWaterfall = {
  /** Total metered spend for the cycle. Equals the sum of the three steps. */
  usedUsdMicros: string;
  plan: CostWaterfallStep;
  credits: CostWaterfallStep;
  card: CostWaterfallStep;
  /** True when no plan allowance applies (pay-per-use). */
  hasPlanAllowance: boolean;
};

/**
 * Build the waterfall.
 *
 * The three applied amounts always sum to `usedUsdMicros`, so every figure on
 * the billing page reconciles against the cycle total without prose.
 *
 * Credits applied are capped at the current prepaid balance: the balance is
 * read live, so it already reflects anything burned earlier in the cycle.
 */
export function buildCostWaterfall(input: {
  usedUsdMicros: string | null | undefined;
  /** Plan included usage allowance for the cycle; null/0 = no allowance. */
  planIncludedUsdMicros?: string | null;
  /** Remaining prepaid credit balance. */
  creditBalanceUsdMicros?: string | null;
}): CostWaterfall {
  const used = parseMicros(input.usedUsdMicros);
  const planCapacity = parseMicros(input.planIncludedUsdMicros);
  const creditBalance = parseMicros(input.creditBalanceUsdMicros);

  const planApplied = minBigInt(used, planCapacity);
  const afterPlan = used - planApplied;

  const creditsApplied = minBigInt(afterPlan, creditBalance);
  const cardApplied = afterPlan - creditsApplied;

  return {
    usedUsdMicros: used.toString(),
    plan: {
      appliedUsdMicros: planApplied.toString(),
      remainingUsdMicros:
        planCapacity > 0n ? (planCapacity - planApplied).toString() : null,
      capacityUsdMicros: planCapacity > 0n ? planCapacity.toString() : null,
    },
    credits: {
      appliedUsdMicros: creditsApplied.toString(),
      remainingUsdMicros: (creditBalance - creditsApplied).toString(),
      capacityUsdMicros: null,
    },
    card: {
      appliedUsdMicros: cardApplied.toString(),
      remainingUsdMicros: null,
      capacityUsdMicros: null,
    },
    hasPlanAllowance: planCapacity > 0n,
  };
}

/**
 * Assign a prepaid credit balance to each subscription waterfall in order so
 * the same remaining balance is not applied on every card.
 * Returns a map of subscriptionId → creditBalanceUsdMicros to pass into each
 * {@link buildCostWaterfall} call.
 */
export function allocateCreditBalancesForSubscriptions(
  subscriptions: ReadonlyArray<{
    subscriptionId: string;
    usedUsdMicros: string;
    discountUsdMicros?: string | null;
  }>,
  startingCreditBalanceUsdMicros: string | null | undefined,
): Map<string, string> {
  let remaining = parseMicros(startingCreditBalanceUsdMicros);
  const allocated = new Map<string, string>();
  for (const row of subscriptions) {
    allocated.set(row.subscriptionId, remaining.toString());
    const used = parseMicros(row.usedUsdMicros);
    const planCapacity = parseMicros(row.discountUsdMicros);
    const afterPlan = used - minBigInt(used, planCapacity);
    remaining -= minBigInt(afterPlan, remaining);
  }
  return allocated;
}

/** Human label for the settlement target, e.g. `Visa ••5094`. */
export function formatPaymentMethodLabel(
  method: { brand?: string | null; last4?: string | null } | null | undefined,
): string | null {
  if (!method) return null;
  const brand = method.brand?.trim();
  const last4 = method.last4?.trim();
  const brandLabel = brand
    ? brand.charAt(0).toUpperCase() + brand.slice(1)
    : "Card";
  return last4 ? `${brandLabel} ••${last4}` : brandLabel;
}
