import { getBillingUsageDashboardData } from "@/lib/billing-usage-dashboard-data";

export type DashboardUsageChartSeries = {
  appId: string;
  appName: string;
  jobType: string;
  totalRequests: number;
  points: { date: string; value: number }[];
};

export type DashboardUsageSummary = {
  cycle: { start: string; end: string };
  chartData: { date: string; value: number }[];
  chartSeries: DashboardUsageChartSeries[];
  totalRequests: number;
  totalNetworkFeeUsdMicros: string;
  appsCount: number;
  appsWithUsage: number;
};

/**
 * Compact usage summary for the Dashboard's usage panel(s). When `ownAppsOnly`
 * is true, the summary is scoped to apps the viewer personally owns or
 * administers — even for admins — otherwise admins/operators see the
 * platform-wide totals.
 */
export async function getDashboardUsageSummary(
  ownAppsOnly: boolean,
): Promise<DashboardUsageSummary | null> {
  const result = await getBillingUsageDashboardData(undefined, { ownAppsOnly });
  if (!result.ok) {
    return null;
  }

  const {
    cycle,
    chartData,
    chartSeries,
    totalRequests,
    totalNetworkFeeUsdMicros,
    orderedApps,
    appsWithUsage,
  } = result.data;

  return {
    cycle,
    chartData,
    chartSeries,
    totalRequests,
    totalNetworkFeeUsdMicros: totalNetworkFeeUsdMicros.toString(),
    appsCount: orderedApps.length,
    appsWithUsage,
  };
}
