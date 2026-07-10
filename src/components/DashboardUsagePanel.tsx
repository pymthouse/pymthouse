import Link from "next/link";
import AllowanceStrip from "@/components/AllowanceStrip";
import InfoTooltip from "@/components/InfoTooltip";
import UsageBreakdownChart from "@/components/UsageBreakdownChart";
import UsageMetricCell from "@/components/UsageMetricCell";
import { formatBillingPeriod, formatPeriodResetLabel } from "@/lib/billing-format";
import {
  getDashboardUsageSummary,
  type DashboardUsageSummary,
} from "@/lib/dashboard-usage-summary";
import { formatUsdMicros } from "@/lib/format-usd";

function DashboardUsageChart({
  appsCount,
  chartSeries,
}: Readonly<{
  appsCount: number;
  chartSeries: DashboardUsageSummary["chartSeries"];
}>) {
  if (appsCount === 0) {
    return (
      <p className="text-sm text-zinc-500">
        Create an app to start tracking your personal usage here.
      </p>
    );
  }
  if (chartSeries.length === 0) {
    return (
      <p className="text-sm text-zinc-500">No usage in the current billing period yet.</p>
    );
  }
  return (
    <UsageBreakdownChart
      series={chartSeries}
      valueLabel="Requests / day"
      height={160}
    />
  );
}

/**
 * Compact usage summary for the current billing period, scoped to apps the
 * viewer personally owns or administers. Chart series are app × pipeline/model
 * (signer constraint), not pipeline capability alone.
 * matching the Admin Dashboard usage panel.
 *
 * Pass `summary` when the parent already loaded it (avoids a second fetch).
 */
export default async function DashboardUsagePanel({
  summary: summaryProp,
}: Readonly<{
  summary?: DashboardUsageSummary | null;
}> = {}) {
  const summary =
    summaryProp !== undefined ? summaryProp : await getDashboardUsageSummary(true);

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

  const totalFeesLabel = formatUsdMicros(totalNetworkFeeUsdMicros, 6) ?? "$0";
  const periodTooltip = [
    `${formatBillingPeriod(cycle.start)} — ${formatBillingPeriod(cycle.end)}`,
    `Resets ${formatPeriodResetLabel(cycle.end)}`,
    "Apps you own or administer",
  ].join("\n");

  return (
    <div className="rounded-xl border border-white/[0.06] bg-white/[0.02] backdrop-blur-sm p-5">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between mb-4">
        <div className="flex items-center gap-1.5">
          <h3 className="font-semibold text-zinc-100">Your usage this billing period</h3>
          <InfoTooltip label={periodTooltip} wide />
        </div>
        <Link
          href="/billing"
          className="shrink-0 text-sm text-emerald-400 hover:text-emerald-300 transition-colors"
        >
          View full usage
        </Link>
      </div>

      <AllowanceStrip
        consumedUsdMicros={totalNetworkFeeUsdMicros}
        requestCount={totalRequests}
      />

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

      <DashboardUsageChart
        appsCount={appsCount}
        chartSeries={chartSeries}
      />
    </div>
  );
}
