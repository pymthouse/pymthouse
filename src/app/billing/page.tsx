export const dynamic = "force-dynamic";

import { redirect } from "next/navigation";

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
        }}
      />
    );
  }

  return <OwnerBillingView data={result.data} />;
}
