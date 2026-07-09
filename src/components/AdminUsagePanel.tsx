"use client";

import { useState } from "react";
import Link from "next/link";
import UsageBreakdownChart from "@/components/UsageBreakdownChart";
import { formatBillingPeriod } from "@/lib/billing-format";
import type { DashboardUsageSummary } from "@/lib/dashboard-usage-summary";
import { formatUsdMicrosString } from "@/lib/format-usd-micros";

export type AdminPlatformStat = {
  label: string;
  value: string;
  sub: string;
  live?: boolean;
};

type UsageTab = "mine" | "all";

function MetricCell({
  label,
  value,
  sub,
  live,
  title,
}: Readonly<{
  label: string;
  value: string;
  sub: string;
  live?: boolean;
  title?: string;
}>) {
  return (
    <div className="min-w-0">
      <div className="flex items-center gap-1.5">
        <p className="text-[11px] font-semibold text-zinc-500 uppercase tracking-widest">
          {label}
        </p>
        {live && (
          <span className="relative flex h-1.5 w-1.5">
            <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-60" />
            <span className="relative inline-flex rounded-full h-1.5 w-1.5 bg-emerald-500" />
          </span>
        )}
      </div>
      <p
        className="text-lg font-bold text-zinc-100 tabular-nums mt-1 truncate"
        title={title ?? value}
      >
        {value}
      </p>
      <p className="text-xs text-zinc-600 mt-0.5 truncate" title={sub}>
        {sub}
      </p>
    </div>
  );
}

function TabButton({
  active,
  onClick,
  children,
}: Readonly<{ active: boolean; onClick: () => void; children: React.ReactNode }>) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition-colors ${
        active
          ? "bg-emerald-500/15 text-emerald-400 shadow-[inset_0_0_0_1px_rgba(52,211,153,0.25)]"
          : "text-zinc-500 hover:text-zinc-300 hover:bg-white/[0.04]"
      }`}
    >
      {children}
    </button>
  );
}

/**
 * Admin Dashboard usage panel. My Usage / All Usage is independent of the
 * Apps section's All apps toggle. Platform signer/volume/revenue stats appear
 * as compact labels on the All Usage tab. Chart series are app × job type,
 * optionally filtered to a selected app from the list below.
 */
export default function AdminUsagePanel({
  initialOwnUsage,
  allUsage,
  loadingAllUsage,
  allUsageError,
  onEnsureAllUsage,
  onRetryAllUsage,
  signerStat,
  volumeStat,
  revenueStat,
  filterAppId = null,
  filterAppName = null,
  onClearAppFilter,
}: Readonly<{
  initialOwnUsage: DashboardUsageSummary | null;
  allUsage: DashboardUsageSummary | null;
  loadingAllUsage: boolean;
  allUsageError: boolean;
  onEnsureAllUsage: () => void;
  onRetryAllUsage: () => void;
  signerStat: AdminPlatformStat;
  volumeStat: AdminPlatformStat;
  revenueStat: AdminPlatformStat;
  filterAppId?: string | null;
  filterAppName?: string | null;
  onClearAppFilter?: () => void;
}>) {
  const [activeTab, setActiveTab] = useState<UsageTab>("mine");

  if (!initialOwnUsage) {
    return null;
  }

  const showingAll = activeTab === "all";
  const summary = showingAll ? allUsage : initialOwnUsage;
  const loading = showingAll && summary === null && loadingAllUsage;
  const failed = showingAll && allUsageError && !loadingAllUsage;

  const filteredSeries =
    summary && filterAppId
      ? summary.chartSeries.filter((s) => s.appId === filterAppId)
      : summary?.chartSeries ?? [];
  const filteredRequests = filteredSeries.reduce((sum, s) => sum + s.totalRequests, 0);
  const filteredAppsWithUsage = filterAppId
    ? filteredSeries.length > 0
      ? 1
      : 0
    : summary?.appsWithUsage ?? 0;
  const filteredAppsCount = filterAppId ? 1 : summary?.appsCount ?? 0;

  const totalFeesLabel = summary
    ? formatUsdMicrosString(summary.totalNetworkFeeUsdMicros, 4) ?? "$0"
    : "$0";

  const selectTab = (tab: UsageTab) => {
    setActiveTab(tab);
    if (tab === "all") onEnsureAllUsage();
  };

  return (
    <div className="rounded-xl border border-white/[0.06] bg-white/[0.02] backdrop-blur-sm p-5">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between mb-4">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-3">
            <h3 className="font-semibold text-zinc-100">
              {showingAll ? "All Usage" : "My Usage"}
            </h3>
            <div className="flex items-center gap-1 rounded-lg bg-black/20 p-0.5">
              <TabButton active={!showingAll} onClick={() => selectTab("mine")}>
                My Usage
              </TabButton>
              <TabButton active={showingAll} onClick={() => selectTab("all")}>
                All Usage
              </TabButton>
            </div>
          </div>
          {summary && (
            <p className="text-xs text-zinc-500 mt-2">
              {formatBillingPeriod(summary.cycle.start)} — {formatBillingPeriod(summary.cycle.end)}
              <span className="ml-2 text-zinc-600">
                · {showingAll ? "all apps on the platform" : "apps you own or administer"}
              </span>
            </p>
          )}
          {filterAppId && filterAppName && (
            <div className="mt-2 inline-flex items-center gap-2 rounded-lg border border-emerald-500/25 bg-emerald-500/10 px-2.5 py-1 text-xs text-emerald-300">
              <span>
                Filtered to <span className="font-medium text-emerald-200">{filterAppName}</span>
              </span>
              {onClearAppFilter && (
                <button
                  type="button"
                  onClick={onClearAppFilter}
                  className="rounded px-1 text-emerald-400/80 hover:bg-emerald-500/20 hover:text-emerald-200"
                  aria-label="Clear app filter"
                >
                  ✕
                </button>
              )}
            </div>
          )}
        </div>
        <Link
          href="/billing"
          className="shrink-0 text-sm text-emerald-400 hover:text-emerald-300 transition-colors"
        >
          View full usage
        </Link>
      </div>

      {failed ? (
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <p className="text-sm text-red-400">Failed to load app usage.</p>
          <button
            type="button"
            onClick={onRetryAllUsage}
            className="shrink-0 text-sm text-emerald-400 hover:text-emerald-300 transition-colors"
          >
            Retry
          </button>
        </div>
      ) : (
        <>
          <div className="mb-5 grid grid-cols-3 gap-4 rounded-lg border border-white/[0.05] bg-black/20 px-3 py-3">
            {showingAll && (
              <>
                <MetricCell
                  label={signerStat.label}
                  value={signerStat.value}
                  sub={signerStat.sub}
                  live={signerStat.live}
                />
                <MetricCell
                  label={volumeStat.label}
                  value={volumeStat.value}
                  sub={volumeStat.sub}
                />
                <MetricCell
                  label={revenueStat.label}
                  value={revenueStat.value}
                  sub={revenueStat.sub}
                />
              </>
            )}
            {loading || !summary ? (
              <>
                {["apps", "requests", "fees"].map((key) => (
                  <div key={key} className="min-w-0 animate-pulse space-y-2">
                    <div className="h-2.5 w-16 rounded bg-zinc-800" />
                    <div className="h-5 w-12 rounded bg-zinc-800" />
                    <div className="h-2.5 w-20 rounded bg-zinc-800/70" />
                  </div>
                ))}
              </>
            ) : (
              <>
                <MetricCell
                  label="Apps"
                  value={String(filteredAppsCount)}
                  sub={
                    filterAppId
                      ? filteredAppsWithUsage
                        ? "with usage"
                        : "no usage this cycle"
                      : `${filteredAppsWithUsage} with usage`
                  }
                />
                <MetricCell
                  label="Requests"
                  value={String(filterAppId ? filteredRequests : summary.totalRequests)}
                  sub="this cycle"
                />
                <MetricCell
                  label="Network fees"
                  value={filterAppId ? "—" : totalFeesLabel}
                  sub={filterAppId ? "see full usage" : "estimated"}
                  title={filterAppId ? undefined : totalFeesLabel}
                />
              </>
            )}
          </div>

          {loading || !summary ? (
            <div className="h-28 animate-pulse rounded bg-zinc-800/60" />
          ) : summary.appsCount === 0 ? (
            <p className="text-sm text-zinc-500">
              {showingAll
                ? "No apps to show usage for yet."
                : "Create an app to start tracking your personal usage here."}
            </p>
          ) : filteredSeries.length === 0 && filterAppId ? (
            <p className="text-sm text-zinc-500">
              No usage for {filterAppName ?? "this app"} in the current billing period.
            </p>
          ) : (
            <UsageBreakdownChart
              series={filteredSeries}
              valueLabel="Requests / day"
              height={160}
            />
          )}
        </>
      )}
    </div>
  );
}
