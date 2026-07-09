"use client";

import { useCallback, useState } from "react";
import AdminAppsSection from "@/components/apps/AdminAppsSection";
import AdminUsagePanel, { type AdminPlatformStat } from "@/components/AdminUsagePanel";
import type { DashboardUsageSummary } from "@/lib/dashboard-usage-summary";
import type { UserAppSummary } from "@/lib/user-apps";

export type AdminStatCard = AdminPlatformStat;

/**
 * Admin Dashboard interactive area, laid out like the Developer Dashboard:
 * apps list first (with an admin-only "All apps" toggle), then the usage
 * panel scoped to that toggle. Platform signer/volume/revenue stats live as
 * compact labels inside the all-apps usage view.
 */
export default function AdminDashboardOverview({
  myApps,
  initialUsage,
  signerStat,
  volumeStat,
  revenueStat,
}: Readonly<{
  myApps: UserAppSummary[];
  initialUsage: DashboardUsageSummary | null;
  signerStat: AdminStatCard;
  volumeStat: AdminStatCard;
  revenueStat: AdminStatCard;
}>) {
  const [showAllApps, setShowAllApps] = useState(false);
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

  const handleToggleShowAll = useCallback(
    (next: boolean) => {
      setShowAllApps(next);
      if (!next || allUsage !== null || loadingAllUsage) return;
      fetchAllUsage();
    },
    [allUsage, loadingAllUsage, fetchAllUsage],
  );

  return (
    <>
      <AdminAppsSection
        initialApps={myApps}
        showAll={showAllApps}
        onToggleShowAll={handleToggleShowAll}
      />

      <div className="mt-6">
        <AdminUsagePanel
          initialOwnUsage={initialUsage}
          allUsage={allUsage}
          loadingAllUsage={loadingAllUsage}
          allUsageError={allUsageError}
          showAllApps={showAllApps}
          onRetryAllUsage={fetchAllUsage}
          signerStat={signerStat}
          volumeStat={volumeStat}
          revenueStat={revenueStat}
        />
      </div>
    </>
  );
}
