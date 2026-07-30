export const dynamic = "force-dynamic";

import DashboardLayout from "@/components/DashboardLayout";
import AppCustomerDetailView from "@/components/AppCustomerDetailView";

export default async function AppUserDetailPage({
  params,
}: Readonly<{
  params: Promise<{ id: string; externalUserId: string }>;
}>) {
  const { id, externalUserId } = await params;
  return (
    <DashboardLayout>
      <AppCustomerDetailView
        appId={id}
        externalUserId={decodeURIComponent(externalUserId)}
      />
    </DashboardLayout>
  );
}
