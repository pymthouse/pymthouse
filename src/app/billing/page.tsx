export const dynamic = "force-dynamic";

import { redirect } from "next/navigation";
import { getServerSession } from "next-auth";

import FundAccountOnRampPanel from "@/components/apps/FundAccountOnRampPanel";
import OwnerBillingView from "@/components/OwnerBillingView";
import OwnerPaymentMethodButton from "@/components/OwnerPaymentMethodButton";
import OwnerPromoteDefaultPaymentMethod from "@/components/OwnerPromoteDefaultPaymentMethod";
import { authOptions } from "@/lib/next-auth-options";
import { ownerEligibleForPaidUpgrade } from "@/lib/billing/owner-paid-upgrade-eligibility";
import { OWNER_STARTER_PLAN_NAME } from "@/lib/openmeter/owner-starter-key";
import { getOwnerBillingData } from "@/lib/owner-billing-data";

function isTurnkeyFundingConfigured(): boolean {
  return Boolean(
    process.env.NEXT_PUBLIC_ORGANIZATION_ID?.trim() &&
      process.env.NEXT_PUBLIC_AUTH_PROXY_CONFIG_ID?.trim(),
  );
}

export default async function BillingPage({
  searchParams,
}: Readonly<{
  searchParams: Promise<{ pm?: string; cycle?: string }>;
}>) {
  const params = await searchParams;
  const result = await getOwnerBillingData(undefined, { cycleKey: params.cycle });
  if (!result.ok) {
    if (result.reason === "no_session") {
      redirect("/login");
    }
    return (
      <OwnerBillingView
        data={{
          userId: "",
          cycle: { start: new Date().toISOString(), end: new Date().toISOString() },
          creditAllowance: null,
          paymentMethods: [],
          hasChargeableBillingMethod: false,
          subscriptions: [],
          ownerStarterPlanName: OWNER_STARTER_PLAN_NAME,
          ownedApps: [],
          invoices: [],
          invoicesDegraded: false,
          stripeInvoices: [],
          ledger: [],
          openMeterConfigured: false,
          fundingClientId: null,
          pendingDowngrade: null,
        }}
      />
    );
  }

  const { data } = result;
  const session = await getServerSession(authOptions);
  const sessionUser = session?.user as Record<string, unknown> | undefined;
  const isAdmin = sessionUser?.role === "admin";
  const fundingClientId = data.fundingClientId?.trim() || null;
  const adminFundAvailable = Boolean(
    isAdmin && isTurnkeyFundingConfigured() && fundingClientId && data.userId,
  );
  const adminFundPanel =
    adminFundAvailable && fundingClientId ? (
      <FundAccountOnRampPanel
        clientId={fundingClientId}
        ownerExternalUserId={data.userId}
      />
    ) : null;

  const hasPaymentMethod = data.paymentMethods.some((pm) => pm.isDefault);
  const hasBillingMethod =
    hasPaymentMethod || data.hasChargeableBillingMethod;
  const eligibleForUpgrade = ownerEligibleForPaidUpgrade(data.subscriptions);

  return (
    <>
      {params.pm === "attached" ? (
        <OwnerPromoteDefaultPaymentMethod replaceHref="/billing" />
      ) : null}
      <OwnerBillingView
        data={data}
        paymentMethodPanel={
          data.openMeterConfigured ? (
            <OwnerPaymentMethodButton
              hasPaymentMethod={hasBillingMethod}
              upgradeFirst={eligibleForUpgrade && !hasBillingMethod}
            />
          ) : null
        }
        adminFundPanel={adminFundPanel}
      />
    </>
  );
}
