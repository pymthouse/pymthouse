export const dynamic = "force-dynamic";

import { redirect } from "next/navigation";

import FundAccountOnRampPanel from "@/components/apps/FundAccountOnRampPanel";
import OwnerBillingView from "@/components/OwnerBillingView";
import { getOwnerBillingData } from "@/lib/owner-billing-data";

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
  const fundPanel =
    data.fundingClientId && data.userId ? (
      <FundAccountOnRampPanel
        clientId={data.fundingClientId}
        ownerExternalUserId={data.userId}
      />
    ) : null;

  return <OwnerBillingView data={data} fundPanel={fundPanel} />;
}
