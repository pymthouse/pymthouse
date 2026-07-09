"use client";

import Link from "next/link";
import UsageLineChart from "@/components/UsageLineChart";
import { formatBillingPeriod } from "@/lib/billing-format";
import type { DashboardUsageSummary } from "@/lib/dashboard-usage-summary";
import { formatUsdMicrosString } from "@/lib/format-usd-micros";

/**
 * Usage panel for the Admin Dashboard. Scope follows the Apps section's
 * "All apps" toggle: own/administered apps by default, or every app on the
 * platform when the toggle is on. All-apps data is fetched by the parent.
 */
export default function AdminUsagePanel({
  initialOwnUsage,
  allUsage,
  loadingAllUsage,
  allUsageError,
  showAllApps,
  onRetryAllUsage,
}: Readonly<{
  initialOwnUsage: DashboardUsageSummary | null;
  allUsage: DashboardUsageSummary | null;
  loadingAllUsage: boolean;
  allUsageError: boolean;
  showAllApps: boolean;
  onRetryAllUsage: () => void;
}>) {
  if (!initialOwnUsage) {
    return null;
  }

  const summary = showAllApps ? allUsage : initialOwnUsage;
  const loading = showAllApps && summary === null && loadingAllUsage;
  const failed = showAllApps && allUsageError && !loadingAllUsage;

  const totalFeesLabel = summary
    ? formatUsdMicrosString(summary.totalNetworkFeeUsdMicros, 4) ?? "$0"
    : "$0";

  return (
    <div className="max-h-[25vh] overflow-y-auto rounded-xl border border-white/[0.06] bg-white/[0.02] backdrop-blur-sm p-5">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between mb-4">
        <div className="min-w-0">
          <h3 className="font-semibold text-zinc-100">
            {showAllApps
              ? "All apps usage this billing period"
              : "Your usage this billing period"}
          </h3>
          {summary && (
            <p className="text-xs text-zinc-500 mt-1">
              {formatBillingPeriod(summary.cycle.start)} — {formatBillingPeriod(summary.cycle.end)}
              {showAllApps && (
                <span className="ml-2 text-zinc-600">· all apps on the platform</span>
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
      ) : loading || !summary ? (
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
              {showAllApps
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
