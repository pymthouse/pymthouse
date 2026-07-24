export const dynamic = "force-dynamic";

import BillingUsageDashboard from "@/components/BillingUsageDashboard";

/** Admin platform-wide usage (`scope=all`). Sticky URL so refresh keeps All Usage. */
export default function UsageAllPage() {
  return <BillingUsageDashboard />;
}
