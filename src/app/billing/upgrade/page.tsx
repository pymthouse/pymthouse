export const dynamic = "force-dynamic";

import { redirect } from "next/navigation";

import OwnerPaidUpgradeCheckout from "@/components/OwnerPaidUpgradeCheckout";
import {
  ownerCanAccessPlanCheckout,
  ownerCurrentPaidPlanKey,
  ownerEligibleForPaidUpgrade,
} from "@/lib/billing/owner-paid-upgrade-eligibility";
import { getOwnerBillingData } from "@/lib/owner-billing-data";

/**
 * Dedicated Owner Paid plan checkout (Upgrade from Starter, or Change plan).
 * Stripe setup Checkout returns here with ?plan=&pm=attached so plan selection
 * survives the redirect. Default-PM promotion runs client-side via authenticated
 * PATCH inside OwnerPaidUpgradeCheckout — not during this GET render.
 */
export default async function BillingUpgradePage({
  searchParams,
}: Readonly<{
  searchParams: Promise<{ plan?: string; pm?: string }>;
}>) {
  const params = await searchParams;
  const result = await getOwnerBillingData();
  if (!result.ok) {
    if (result.reason === "no_session") {
      redirect("/login");
    }
    redirect("/billing");
  }

  const { data } = result;
  if (!data.openMeterConfigured) {
    redirect("/billing");
  }
  if (!ownerCanAccessPlanCheckout(data.subscriptions)) {
    redirect("/billing");
  }

  const defaultPm =
    data.paymentMethods.find((m) => m.isDefault) ??
    data.paymentMethods[0] ??
    null;
  const initialPlanKey =
    typeof params.plan === "string" && params.plan.trim()
      ? params.plan.trim()
      : null;
  const currentPlanKey = ownerCurrentPaidPlanKey(data.subscriptions);
  const mode = ownerEligibleForPaidUpgrade(data.subscriptions)
    ? "upgrade"
    : "change";
  const hasBillingMethod =
    data.paymentMethods.some((pm) => pm.isDefault) ||
    data.hasChargeableBillingMethod;

  return (
    <OwnerPaidUpgradeCheckout
      mode={mode}
      currentPlanKey={currentPlanKey}
      hasPaymentMethod={hasBillingMethod}
      paymentMethod={
        defaultPm
          ? {
              brand: defaultPm.brand,
              last4: defaultPm.last4,
              type: defaultPm.type,
            }
          : null
      }
      initialPlanKey={initialPlanKey}
      pmAttached={params.pm === "attached"}
    />
  );
}
