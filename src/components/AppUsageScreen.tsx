"use client";

import AppCustomersPanel from "@/components/AppCustomersPanel";
import AppUsageTabs from "@/components/AppUsageTabs";
import BillingUsageDashboard from "@/components/BillingUsageDashboard";
import DashboardLayout from "@/components/DashboardLayout";

export default function AppUsageScreen({
  appId,
  tab,
}: Readonly<{
  appId: string;
  tab: "usage" | "users";
}>) {
  if (tab === "users") {
    return (
      <DashboardLayout>
        <AppUsageTabs appId={appId} active="users" />
        <AppCustomersPanel appId={appId} />
      </DashboardLayout>
    );
  }

  return (
    <BillingUsageDashboard
      filterAppId={appId}
      headerSlot={<AppUsageTabs appId={appId} active="usage" />}
    />
  );
}
