import { isOwnerPaidPlanKey } from "@/lib/openmeter/owner-paid-key";

type SubscriptionRow = {
  openMeterPlanKey?: string | null;
  appPublicClientId?: string | null;
};

function walletSubscriptionRows(
  subscriptions: ReadonlyArray<SubscriptionRow>,
): SubscriptionRow[] {
  const walletRows = subscriptions.filter((row) => row.appPublicClientId == null);
  return walletRows.length > 0 ? [...walletRows] : [...subscriptions];
}

/**
 * True when /billing should offer the Owner Paid Upgrade CTA.
 *
 * Eligible when the shared owner wallet is not already on an Owner Paid tier —
 * including empty subscription lists (Starter not provisioned yet, or a soft
 * timeout). Gating only on Starter plan-key detection hid the CTA for those
 * cases and left “Add payment method” as the primary action.
 */
export function ownerEligibleForPaidUpgrade(
  subscriptions: ReadonlyArray<SubscriptionRow>,
): boolean {
  const rows = walletSubscriptionRows(subscriptions);
  if (rows.length === 0) return true;
  return !rows.some((row) => isOwnerPaidPlanKey(row.openMeterPlanKey));
}

/** Current Owner Paid plan key on the wallet, if any. */
export function ownerCurrentPaidPlanKey(
  subscriptions: ReadonlyArray<SubscriptionRow>,
): string | null {
  for (const row of walletSubscriptionRows(subscriptions)) {
    const key = row.openMeterPlanKey?.trim() || null;
    if (key && isOwnerPaidPlanKey(key)) {
      return key;
    }
  }
  return null;
}

/** True when the wallet is already on an Owner Paid tier (can switch tiers). */
export function ownerCanChangePaidPlan(
  subscriptions: ReadonlyArray<SubscriptionRow>,
): boolean {
  return ownerCurrentPaidPlanKey(subscriptions) != null;
}

/**
 * True when /billing/upgrade should be reachable — either first Upgrade from
 * Starter, or Change plan among Owner Paid tiers.
 */
export function ownerCanAccessPlanCheckout(
  subscriptions: ReadonlyArray<SubscriptionRow>,
): boolean {
  return (
    ownerEligibleForPaidUpgrade(subscriptions) ||
    ownerCanChangePaidPlan(subscriptions)
  );
}
