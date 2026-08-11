import {
  ownerCanChangePaidPlan,
  ownerCurrentLivePaidPlanKey,
  ownerEligibleForPaidUpgrade,
} from "@/lib/billing/owner-paid-upgrade-eligibility";
import { resolvePlatformOwnerStarterPlanName } from "@/lib/billing/platform-owner-starter-default";
import { ownerHasChargeablePaymentMethod } from "@/lib/openmeter/owner-payment-method";
import {
  deriveOwnerPendingDowngrade,
  type OwnerPendingDowngrade,
} from "@/lib/openmeter/owner-starter-downgrade";
import { listOwnerActiveSubscriptions } from "@/lib/owner-billing-data";

/** Compact Owner Paid switching status for M2M integrators. */
export async function getOwnerSubscriptionSwitchingStatus(
  ownerUserId: string,
): Promise<{
  ownerUserId: string;
  /** `null` when Stripe/OpenMeter is unavailable to probe. */
  hasChargeablePaymentMethod: boolean | null;
  livePaidPlanKey: string | null;
  eligibleForPaidUpgrade: boolean;
  canChangePaidPlan: boolean;
  pendingDowngrade: OwnerPendingDowngrade | null;
  subscriptions: Array<{
    subscriptionId: string;
    status: string;
    planName: string;
    openMeterPlanKey: string | null;
    activeFrom: string | null;
    activeTo: string | null;
  }>;
}> {
  const subscriptions = await listOwnerActiveSubscriptions(ownerUserId);
  const starterPlanName = await resolvePlatformOwnerStarterPlanName();
  const { displaySubscriptions, pendingDowngrade } = deriveOwnerPendingDowngrade({
    subscriptions,
    starterPlanName,
  });

  return {
    ownerUserId,
    hasChargeablePaymentMethod:
      await ownerHasChargeablePaymentMethod(ownerUserId),
    livePaidPlanKey: ownerCurrentLivePaidPlanKey(displaySubscriptions),
    eligibleForPaidUpgrade: ownerEligibleForPaidUpgrade(displaySubscriptions),
    canChangePaidPlan: ownerCanChangePaidPlan(displaySubscriptions),
    pendingDowngrade,
    subscriptions: displaySubscriptions.map((row) => ({
      subscriptionId: row.subscriptionId,
      status: row.status,
      planName: row.planName,
      openMeterPlanKey: row.openMeterPlanKey,
      activeFrom: row.activeFrom,
      activeTo: row.activeTo,
    })),
  };
}
