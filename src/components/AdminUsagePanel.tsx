"use client";

import { useState } from "react";
import Link from "next/link";
import UsageLineChart from "@/components/UsageLineChart";
import { formatBillingPeriod } from "@/lib/billing-usage-dashboard-data";
import type { DashboardUsageSummary } from "@/lib/dashboard-usage-summary";
import { formatUsdMicrosString } from "@/lib/format-usd-micros";

type UsageTab = "mine" | "apps";

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
 * Usage panel for the Admin Dashboard with a "Your Usage" / "App Usage" tab
 * switch. "App Usage" mirrors whatever the Apps section's "All apps" toggle
 * is currently showing — the viewer's own apps, or every app on the
 * platform. The all-apps usage data itself is fetched by the parent
 * (triggered from the "All apps" toggle click) so this component stays a
 * pure display of whatever summaries it's handed.
 */
export default function AdminUsagePanel({
  initialOwnUsage,
  allUsage,
  loadingAllUsage,
  showAllApps,
}: Readonly<{
  initialOwnUsage: DashboardUsageSummary | null;
  allUsage: DashboardUsageSummary | null;
  loadingAllUsage: boolean;
  showAllApps: boolean;
}>) {
  const [activeTab, setActiveTab] = useState<UsageTab>("mine");

  if (!initialOwnUsage) {
    return null;
  }

  const showingApps = activeTab === "apps";
  const usingAllScope = showingApps && showAllApps;
  const summary = usingAllScope ? allUsage : initialOwnUsage;
  const loading = usingAllScope && summary === null && loadingAllUsage;

  const totalFeesLabel = summary
    ? formatUsdMicrosString(summary.totalNetworkFeeUsdMicros, 4) ?? "$0"
    : "$0";

  return (
    <div className="max-h-[25vh] overflow-y-auto rounded-xl border border-white/[0.06] bg-white/[0.02] backdrop-blur-sm p-5">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between mb-4">
        <div className="min-w-0">
          <div className="flex items-center gap-3">
            <h3 className="font-semibold text-zinc-100">
              {showingApps ? "App Usage" : "Your Usage"}
            </h3>
            <div className="flex items-center gap-1 rounded-lg bg-black/20 p-0.5">
              <TabButton active={!showingApps} onClick={() => setActiveTab("mine")}>
                Your Usage
              </TabButton>
              <TabButton active={showingApps} onClick={() => setActiveTab("apps")}>
                App Usage
              </TabButton>
            </div>
          </div>
          {summary && (
            <p className="text-xs text-zinc-500 mt-2">
              {formatBillingPeriod(summary.cycle.start)} — {formatBillingPeriod(summary.cycle.end)}
              {showingApps && (
                <span className="ml-2 text-zinc-600">
                  · {showAllApps ? "all apps on the platform" : "apps you own or administer"}
                </span>
              )}
            </p>
          )}
        </div>
        <Link
          href="/billing"
          className="shrink-0 text-sm text-emerald-400 hover:text-emerald-300 transition-colors"
        >
          View full usage →
        </Link>
      </div>

      {loading || !summary ? (
        <div className="animate-pulse space-y-3">
          <div className="grid grid-cols-3 gap-4">
            {["a", "b", "c"].map((key) => (
              <div key={key} className="space-y-2">
                <div className="h-2.5 w-16 rounded bg-zinc-800" />
                <div className="h-4 w-10 rounded bg-zinc-800" />
              </div>
            ))}
          </div>
          <div className="h-16 rounded bg-zinc-800/60" />
        </div>
      ) : (
        <>
          <div className="grid grid-cols-3 gap-4 mb-5">
            <div>
              <p className="text-[11px] font-semibold text-zinc-500 uppercase tracking-widest">
                Apps
              </p>
              <p className="text-lg font-bold text-zinc-100 tabular-nums mt-1">
                {summary.appsCount}
              </p>
              <p className="text-xs text-zinc-600 mt-0.5">{summary.appsWithUsage} with usage</p>
            </div>
            <div>
              <p className="text-[11px] font-semibold text-zinc-500 uppercase tracking-widest">
                Requests
              </p>
              <p className="text-lg font-bold text-zinc-100 tabular-nums mt-1">
                {summary.totalRequests}
              </p>
              <p className="text-xs text-zinc-600 mt-0.5">this cycle</p>
            </div>
            <div>
              <p className="text-[11px] font-semibold text-zinc-500 uppercase tracking-widest">
                Network fees
              </p>
              <p
                className="text-lg font-bold text-emerald-400 tabular-nums mt-1"
                title={totalFeesLabel}
              >
                {totalFeesLabel}
              </p>
              <p className="text-xs text-zinc-600 mt-0.5">estimated</p>
            </div>
          </div>

          {summary.appsCount === 0 ? (
            <p className="text-sm text-zinc-500">
              {showingApps
                ? "No apps to show usage for yet."
                : "Create an app to start tracking your personal usage here."}
            </p>
          ) : (
            <UsageLineChart data={summary.chartData} valueLabel="Requests / day" height={110} />
          )}
        </>
      )}
    </div>
  );
}
