"use client";

import { useCallback, useState } from "react";
import AdminAppsSection from "@/components/apps/AdminAppsSection";
import AdminUsagePanel, { type AdminPlatformStat } from "@/components/AdminUsagePanel";
import type { DashboardUsageSummary } from "@/lib/dashboard-usage-summary";
import type { UserAppSummary } from "@/lib/user-apps";

export type AdminStatCard = AdminPlatformStat;

/**
 * Admin Dashboard interactive area: usage panel on top (My Usage / All Usage),
 * then the apps list with its own independent All apps toggle. Selecting an
 * app in the list filters the usage chart to that app.
 */
export default function AdminDashboardOverview({
  myApps,
  initialUsage,
  volumeStat,
}: Readonly<{
  myApps: UserAppSummary[];
  initialUsage: DashboardUsageSummary | null;
  volumeStat: AdminStatCard;
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

  return (
    <>
      <div className="mb-6">
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
        />
      </div>

      <AdminAppsSection
        initialApps={myApps}
        showAll={showAllApps}
        onToggleShowAll={setShowAllApps}
        selectedAppId={selectedApp?.id ?? null}
        onSelectApp={handleSelectApp}
      />
    </>
  );
}
