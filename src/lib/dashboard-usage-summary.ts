import { getBillingUsageDashboardData } from "@/lib/billing-usage-dashboard-data";
import type { CreditAllowanceSummary } from "@/lib/openmeter/credit-allowance-summary";

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
  /** Per-app network fees keyed by public OIDC client_id (matches chartSeries.appId). */
  feesByAppId: Record<string, string>;
  appsCount: number;
  appsWithUsage: number;
  /**
   * Sum of live prepaid credit ledgers for end-user customers under the
   * summary's apps (one Konnect customer per app user — same balances the
   * mint / remote-signer gates use). Null when hosted credits are unavailable.
   */
  creditAllowance: CreditAllowanceSummary | null;
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
    appUsage,
    creditAllowance,
  } = result.data;

  const feesByAppId: Record<string, string> = {};
  for (const row of appUsage) {
    feesByAppId[row.app.publicClientId] = row.networkFeeUsdMicros;
  }

  return {
    cycle,
    chartData,
    chartSeries,
    totalRequests,
    totalNetworkFeeUsdMicros: totalNetworkFeeUsdMicros.toString(),
    feesByAppId,
    appsCount: orderedApps.length,
    appsWithUsage,
    creditAllowance,
  };
}
