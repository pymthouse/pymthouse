export const dynamic = "force-dynamic";

import { redirect } from "next/navigation";

import FundAccountOnRampPanel from "@/components/apps/FundAccountOnRampPanel";
import OwnerBillingView from "@/components/OwnerBillingView";
import { getOwnerBillingData } from "@/lib/owner-billing-data";

function isTurnkeyFundingConfigured(): boolean {
  return Boolean(
    process.env.NEXT_PUBLIC_ORGANIZATION_ID?.trim() &&
      process.env.NEXT_PUBLIC_AUTH_PROXY_CONFIG_ID?.trim(),
  );
}

export default async function BillingPage() {
  const result = await getOwnerBillingData();
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
          subscriptions: [],
          openMeterConfigured: false,
          fundingClientId: null,
        }}
      />
    );
  }

  const { data } = result;
  const fundingClientId = data.fundingClientId?.trim() || null;
  const fundingAvailable = Boolean(
    isTurnkeyFundingConfigured() && fundingClientId && data.userId,
  );
  const fundPanel =
    fundingAvailable && fundingClientId ? (
      <FundAccountOnRampPanel
        clientId={fundingClientId}
        ownerExternalUserId={data.userId}
      />
    ) : null;

  return (
    <OwnerBillingView
      data={data}
      fundPanel={fundPanel}
      fundingAvailable={fundingAvailable}
    />
  );
}
