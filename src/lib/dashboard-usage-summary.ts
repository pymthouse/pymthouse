import { getBillingUsageDashboardData } from "@/lib/billing-usage-dashboard-data";
import {
  getOwnerPrepaidCreditBalance,
  getPrepaidCreditBalancesByClientId,
  type CreditAllowanceSummary,
} from "@/lib/openmeter/credit-allowance-summary";

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
   * Shared owner prepaid wallet (`owner:{users.id}`) when the viewer is known.
   * Null when hosted credits are unavailable or the viewer has no owner wallet yet.
   */
  creditAllowance: CreditAllowanceSummary | null;
  /**
   * Same owner wallet keyed by each owned app's public client id — used when the
   * Dashboard filter selects exactly one app (credits are per owner, not per app).
   */
  creditAllowanceByAppId: Record<string, CreditAllowanceSummary>;
  /**
   * End-user prepaid wallet sums per app (excludes owner wallets). Used by
   * app usage pages / admin views that need tenant end-user totals.
   */
  endUserCreditAllowanceByAppId: Record<string, CreditAllowanceSummary>;
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
    userId,
  } = result.data;

  const feesByAppId: Record<string, string> = {};
  for (const row of appUsage) {
    feesByAppId[row.app.publicClientId] = row.networkFeeUsdMicros;
  }

  const publicClientIds = orderedApps.map((app) => app.publicClientId);

  let creditAllowance: CreditAllowanceSummary | null = null;
  let creditAllowanceByAppId: Record<string, CreditAllowanceSummary> = {};
  let endUserCreditAllowanceByAppId: Record<string, CreditAllowanceSummary> = {};
  try {
    endUserCreditAllowanceByAppId =
      await getPrepaidCreditBalancesByClientId(publicClientIds);
    creditAllowance = await getOwnerPrepaidCreditBalance(userId);
    if (creditAllowance) {
      for (const app of orderedApps) {
        if (app.ownerId === userId) {
          creditAllowanceByAppId[app.publicClientId] = creditAllowance;
        }
      }
    }
  } catch (err) {
    console.warn(
      "dashboard-usage-summary: prepaid credit lookup failed",
      err instanceof Error ? err.message : String(err),
    );
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
    creditAllowanceByAppId,
    endUserCreditAllowanceByAppId,
  };
}
