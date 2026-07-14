export const dynamic = "force-dynamic";

import BillingUsageDashboard from "@/components/BillingUsageDashboard";

export default async function AppUsagePage({
  params,
}: Readonly<{
  params: Promise<{ id: string }>;
}>) {
  const { id } = await params;
  return <BillingUsageDashboard filterAppId={id} />;
}
