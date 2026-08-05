import { isOwnerPaidPlanKey } from "@/lib/openmeter/owner-paid-key";

/**
 * True when /billing should offer the Owner Paid Upgrade CTA.
 *
 * Eligible when the shared owner wallet is not already on an Owner Paid tier —
 * including empty subscription lists (Starter not provisioned yet, or a soft
 * timeout). Gating only on Starter plan-key detection hid the CTA for those
 * cases and left “Add payment method” as the primary action.
 */
export function ownerEligibleForPaidUpgrade(
  subscriptions: ReadonlyArray<{
    openMeterPlanKey?: string | null;
    appPublicClientId?: string | null;
  }>,
): boolean {
  const walletRows = subscriptions.filter((row) => row.appPublicClientId == null);
  const rows = walletRows.length > 0 ? walletRows : subscriptions;
  if (rows.length === 0) return true;
  return !rows.some((row) => isOwnerPaidPlanKey(row.openMeterPlanKey));
}
