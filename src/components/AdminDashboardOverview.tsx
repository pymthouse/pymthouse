"use client";

import { useCallback, useState } from "react";
import AdminAppsSection from "@/components/apps/AdminAppsSection";
import AdminUsagePanel from "@/components/AdminUsagePanel";
import type { DashboardUsageSummary } from "@/lib/dashboard-usage-summary";
import type { UserAppSummary } from "@/lib/user-apps";

export type AdminStatCard = {
  label: string;
  value: string;
  sub: string;
  color: string;
  glow: string;
  live: boolean;
};

function StatCard({ stat }: Readonly<{ stat: AdminStatCard }>) {
  return (
    <div
      className={`relative overflow-hidden rounded-xl border bg-white/[0.02] backdrop-blur-sm p-5 transition-colors hover:bg-white/[0.035] ${stat.glow}`}
    >
      <div className="flex items-center justify-between mb-3">
        <p className="text-[11px] font-semibold text-zinc-500 uppercase tracking-widest">
          {stat.label}
        </p>
        {stat.live && (
          <span className="relative flex h-1.5 w-1.5">
            <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-60" />
            <span className="relative inline-flex rounded-full h-1.5 w-1.5 bg-emerald-500" />
          </span>
        )}
      </div>
      <p className={`text-2xl font-bold tabular-nums leading-none ${stat.color}`}>{stat.value}</p>
      <p className="text-xs text-zinc-600 mt-2 leading-snug">{stat.sub}</p>
    </div>
  );
}

/**
 * Orchestrates the Admin Dashboard's interactive area: a single "All apps"
 * toggle shared between the Apps section and the Usage panel's "App Usage"
 * tab, plus platform-wide volume/revenue stats that only make sense (and
 * only render) once "All apps" is switched on.
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
      <div className="mb-8">
        <AdminUsagePanel
          initialOwnUsage={initialUsage}
          allUsage={allUsage}
          loadingAllUsage={loadingAllUsage}
          allUsageError={allUsageError}
          showAllApps={showAllApps}
          onRetryAllUsage={fetchAllUsage}
        />
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4 mb-8">
        <StatCard stat={signerStat} />
        {showAllApps && <StatCard stat={volumeStat} />}
        {showAllApps && <StatCard stat={revenueStat} />}
      </div>

      <AdminAppsSection
        initialApps={myApps}
        showAll={showAllApps}
        onToggleShowAll={handleToggleShowAll}
      />
    </>
  );
}
