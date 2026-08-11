import { isOwnerPaidPlanKey } from "@/lib/openmeter/owner-paid-key";

type SubscriptionRow = {
  openMeterPlanKey?: string | null;
  appPublicClientId?: string | null;
  status?: string | null;
};

function walletSubscriptionRows(
  subscriptions: ReadonlyArray<SubscriptionRow>,
): SubscriptionRow[] {
  const walletRows = subscriptions.filter((row) => row.appPublicClientId == null);
  return walletRows.length > 0 ? [...walletRows] : [...subscriptions];
}

/**
 * Live Owner Paid key — skips canceled/inactive Paid left behind a scheduled
 * Starter successor (resume-blocked), so Upgrade stays available instead of
 * looking like a normal Change-plan wallet.
 */
export function ownerCurrentLivePaidPlanKey(
  subscriptions: ReadonlyArray<SubscriptionRow>,
): string | null {
  for (const row of walletSubscriptionRows(subscriptions)) {
    const status = (row.status || "").toLowerCase();
    if (status === "canceled" || status === "inactive") {
      continue;
    }
    const key = row.openMeterPlanKey?.trim() || null;
    if (key && isOwnerPaidPlanKey(key)) {
      return key;
    }
  }
  return null;
}

/**
 * True when /billing should offer the Owner Paid Upgrade CTA.
 *
 * Eligible when the shared owner wallet is not already on a live Owner Paid
 * tier — including empty lists, Starter-only, and canceled-Paid + scheduled
 * Starter (Konnect-blocked) wallets.
 */
export function ownerEligibleForPaidUpgrade(
  subscriptions: ReadonlyArray<SubscriptionRow>,
): boolean {
  return ownerCurrentLivePaidPlanKey(subscriptions) == null;
}

/**
 * Any Owner Paid plan key on the wallet (including canceled). Used for
 * checkout preselect / resume-current-plan detection.
 */
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

/** True when the wallet is on a live Owner Paid tier (can switch tiers). */
export function ownerCanChangePaidPlan(
  subscriptions: ReadonlyArray<SubscriptionRow>,
): boolean {
  return ownerCurrentLivePaidPlanKey(subscriptions) != null;
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
