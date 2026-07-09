import Link from "next/link";
import UsageBreakdownChart from "@/components/UsageBreakdownChart";
import UsageMetricCell from "@/components/UsageMetricCell";
import { formatBillingPeriod } from "@/lib/billing-format";
import { getDashboardUsageSummary } from "@/lib/dashboard-usage-summary";
import { formatUsdMicrosString } from "@/lib/format-usd-micros";

/**
 * Compact usage summary for the current billing period, scoped to apps the
 * viewer personally owns or administers. Chart series are app × job type,
 * matching the Admin Dashboard usage panel.
 */
export default async function DashboardUsagePanel() {
  const summary = await getDashboardUsageSummary(true);

  if (!summary) {
    return null;
  }

  const {
    cycle,
    chartSeries,
    totalRequests,
    totalNetworkFeeUsdMicros,
    appsCount,
    appsWithUsage,
  } = summary;

  const totalFeesLabel = formatUsdMicrosString(totalNetworkFeeUsdMicros, 4) ?? "$0";

  return (
    <div className="rounded-xl border border-white/[0.06] bg-white/[0.02] backdrop-blur-sm p-5">
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
          View full usage
        </Link>
      </div>

      <div className="mb-5 grid grid-cols-3 gap-4 rounded-lg border border-white/[0.05] bg-black/20 px-3 py-3">
        <UsageMetricCell
          label="Apps"
          value={String(appsCount)}
          sub={`${appsWithUsage} with usage`}
        />
        <UsageMetricCell
          label="Requests"
          value={String(totalRequests)}
          sub="this cycle"
        />
        <UsageMetricCell
          label="Network fees"
          value={totalFeesLabel}
          sub="USD from usage events this cycle"
          title={totalFeesLabel}
        />
      </div>

      {appsCount === 0 ? (
        <p className="text-sm text-zinc-500">
          Create an app to start tracking your personal usage here.
        </p>
      ) : chartSeries.length === 0 ? (
        <p className="text-sm text-zinc-500">No usage in the current billing period yet.</p>
      ) : (
        <UsageBreakdownChart
          series={chartSeries}
          valueLabel="Requests / day"
          height={160}
        />
      )}
    </div>
  );
}
