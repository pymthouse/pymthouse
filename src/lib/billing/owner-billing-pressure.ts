/**
 * Owner billing pressure states for the Starter → attach-card product surface.
 *
 * Client-safe (no DB/Node imports) — used from /billing and the usage dashboard.
 *
 * - solvent: still has plan allowance or prepaid credits; soft CTA to attach a card
 * - blocked: spendable is zero and no card — usage is paused until they attach one
 * - chargeable: a payment method is on file; overage can invoice
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

export type OwnerBillingPressure = "solvent" | "blocked" | "chargeable";

export type OwnerBillingPressureSubscription = {
  /** Null when billed on the shared owner wallet. */
  appPublicClientId?: string | null;
  discountUsdMicros: string | null;
  usedUsdMicros: string;
};

/**
 * Remaining spendable for pressure UI: prepaid credits + remaining included
 * usage on the shared owner-wallet subscription (same settlement target as
 * the mint/signer gate for owner_rollup).
 */
export function ownerSpendableRemainingUsdMicros(input: {
  creditBalanceUsdMicros?: string | null;
  subscriptions: OwnerBillingPressureSubscription[];
}): bigint {
  const credits = parseMicros(input.creditBalanceUsdMicros);
  const wallet =
    input.subscriptions.find((row) => row.appPublicClientId == null) ??
    input.subscriptions[0];
  if (!wallet) {
    return credits;
  }
  const discount = parseMicros(wallet.discountUsdMicros);
  const used = parseMicros(wallet.usedUsdMicros);
  const planRemaining = discount > used ? discount - used : 0n;
  return credits + planRemaining;
}

/**
 * Resolve the owner billing pressure state.
 *
 * Owners with no subscription yet stay `solvent` so the empty-state soft CTA
 * is used rather than a hard “usage paused” banner before Starter exists.
 */
export function resolveOwnerBillingPressure(input: {
  hasPaymentMethod: boolean;
  creditBalanceUsdMicros?: string | null;
  subscriptions: OwnerBillingPressureSubscription[];
}): OwnerBillingPressure {
  if (input.hasPaymentMethod) {
    return "chargeable";
  }
  if (input.subscriptions.length === 0) {
    return "solvent";
  }
  const remaining = ownerSpendableRemainingUsdMicros(input);
  return remaining > 0n ? "solvent" : "blocked";
}
