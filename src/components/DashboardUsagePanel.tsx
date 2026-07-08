import Link from "next/link";
import UsageLineChart from "@/components/UsageLineChart";
import { formatBillingPeriod } from "@/lib/billing-usage-dashboard-data";
import { getDashboardUsageSummary } from "@/lib/dashboard-usage-summary";
import { formatUsdMicrosString } from "@/lib/format-usd-micros";

/**
 * Compact usage summary for the current billing period, scoped to apps the
 * viewer personally owns or administers — even for admins, who can see all
 * apps on the dedicated Usage page instead.
 */
export default async function DashboardUsagePanel() {
  const summary = await getDashboardUsageSummary(true);

  if (!summary) {
    return null;
  }

  const { cycle, chartData, totalRequests, totalNetworkFeeUsdMicros, appsCount, appsWithUsage } =
    summary;

  const totalFeesLabel = formatUsdMicrosString(totalNetworkFeeUsdMicros, 4) ?? "$0";

  return (
    <div className="max-h-[25vh] overflow-y-auto rounded-xl border border-white/[0.06] bg-white/[0.02] backdrop-blur-sm p-5">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between mb-4">
        <div>
          <h3 className="font-semibold text-zinc-100">Your usage this billing period</h3>
          <p className="text-xs text-zinc-500 mt-1">
            {formatBillingPeriod(cycle.start)} — {formatBillingPeriod(cycle.end)}
          </p>
        </div>
        <Link
          href="/billing"
          className="shrink-0 text-sm text-emerald-400 hover:text-emerald-300 transition-colors"
        >
          View full usage →
        </Link>
      </div>

      <div className="grid grid-cols-3 gap-4 mb-5">
        <div>
          <p className="text-[11px] font-semibold text-zinc-500 uppercase tracking-widest">
            Apps
          </p>
          <p className="text-lg font-bold text-zinc-100 tabular-nums mt-1">{appsCount}</p>
          <p className="text-xs text-zinc-600 mt-0.5">{appsWithUsage} with usage</p>
        </div>
        <div>
          <p className="text-[11px] font-semibold text-zinc-500 uppercase tracking-widest">
            Requests
          </p>
          <p className="text-lg font-bold text-zinc-100 tabular-nums mt-1">{totalRequests}</p>
          <p className="text-xs text-zinc-600 mt-0.5">this cycle</p>
        </div>
        <div>
          <p className="text-[11px] font-semibold text-zinc-500 uppercase tracking-widest">
            Network fees
          </p>
          <p className="text-lg font-bold text-emerald-400 tabular-nums mt-1" title={totalFeesLabel}>
            {totalFeesLabel}
          </p>
          <p className="text-xs text-zinc-600 mt-0.5">estimated</p>
        </div>
      </div>

      {appsCount === 0 ? (
        <p className="text-sm text-zinc-500">
          Create an app to start tracking your personal usage here.
        </p>
      ) : (
        <UsageLineChart data={chartData} valueLabel="Requests / day" height={110} />
      )}
    </div>
  );
}
