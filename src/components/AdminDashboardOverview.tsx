"use client";

import { useCallback, useState } from "react";
import AdminAppsSection from "@/components/apps/AdminAppsSection";
import AdminUsagePanel, { type AdminPlatformStat } from "@/components/AdminUsagePanel";
import type { DashboardUsageSummary } from "@/lib/dashboard-usage-summary";
import type { UserAppSummary } from "@/lib/user-apps";
import type { ViewerAllowanceSummary } from "@/lib/viewer-allowance-summary";

export type AdminStatCard = AdminPlatformStat;

/**
 * Admin Dashboard interactive area: Apps first until the viewer has usage to
 * show this cycle, then Usage above Apps. Selecting an app in the list filters
 * the usage chart. My Usage / All Usage is independent of the Apps "All apps" toggle.
 */
export default function AdminDashboardOverview({
  myApps,
  initialUsage,
  volumeStat,
  allowance = null,
}: Readonly<{
  myApps: UserAppSummary[];
  initialUsage: DashboardUsageSummary | null;
  volumeStat: AdminStatCard;
  allowance?: ViewerAllowanceSummary | null;
}>) {
  const [showAllApps, setShowAllApps] = useState(false);
  const [selectedApp, setSelectedApp] = useState<UserAppSummary | null>(null);
  const [allUsage, setAllUsage] = useState<DashboardUsageSummary | null>(null);
  const [loadingAllUsage, setLoadingAllUsage] = useState(false);
  const [allUsageError, setAllUsageError] = useState(false);

  const fetchAllUsage = useCallback(() => {
    if (loadingAllUsage) return;
    setLoadingAllUsage(true);
    setAllUsageError(false);
    fetch("/api/v1/dashboard/usage?scope=all")
      .then((r) => {
        if (!r.ok) throw new Error("Failed to load app usage");
        return r.json();
      })
      .then((data: DashboardUsageSummary) => setAllUsage(data))
      .catch(() => {
        setAllUsage(null);
        setAllUsageError(true);
      })
      .finally(() => setLoadingAllUsage(false));
  }, [loadingAllUsage]);

  const ensureAllUsage = useCallback(() => {
    if (allUsage !== null || loadingAllUsage) return;
    fetchAllUsage();
  }, [allUsage, loadingAllUsage, fetchAllUsage]);

  const handleSelectApp = useCallback((app: UserAppSummary | null) => {
    setSelectedApp(app);
  }, []);

  // Keep Apps above Usage until there is something to chart — creating an empty
  // app should not rearrange the page.
  const usageFirst = (initialUsage?.appsWithUsage ?? 0) > 0;

  const usagePanel = (
    <AdminUsagePanel
      initialOwnUsage={initialUsage}
      allUsage={allUsage}
      loadingAllUsage={loadingAllUsage}
      allUsageError={allUsageError}
      onEnsureAllUsage={ensureAllUsage}
      onRetryAllUsage={fetchAllUsage}
      volumeStat={volumeStat}
      filterAppId={selectedApp?.id ?? null}
      filterAppName={selectedApp?.name ?? null}
      onClearAppFilter={() => setSelectedApp(null)}
      allowance={allowance}
    />
  );

  const appsSection = (
    <AdminAppsSection
      initialApps={myApps}
      showAll={showAllApps}
      onToggleShowAll={setShowAllApps}
      selectedAppId={selectedApp?.id ?? null}
      onSelectApp={handleSelectApp}
    />
  );

  return (
    <>
      {usageFirst ? (
        <>
          <div className="mb-6">{usagePanel}</div>
          {appsSection}
        </>
      ) : (
        <>
          {appsSection}
          <div className="mt-6">{usagePanel}</div>
        </>
      )}
    </>
  );
}
