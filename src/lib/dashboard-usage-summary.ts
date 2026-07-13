import { getBillingUsageDashboardData } from "@/lib/billing-usage-dashboard-data";
import {
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
   * Live prepaid credit ledger for end-users under the summary's apps
   * (same Konnect balance the mint / remote-signer gates use). Null when
   * hosted credits are unavailable.
   */
  creditAllowance: CreditAllowanceSummary | null;
  /**
   * Per-application prepaid credits keyed by public OIDC client_id.
   * Used when the Dashboard filter selects exactly one app.
   */
  creditAllowanceByAppId: Record<string, CreditAllowanceSummary>;
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
  } = result.data;

  const feesByAppId: Record<string, string> = {};
  for (const row of appUsage) {
    feesByAppId[row.app.publicClientId] = row.networkFeeUsdMicros;
  }

  const publicClientIds = orderedApps.map((app) => app.publicClientId);

  let creditAllowance: CreditAllowanceSummary | null = null;
  let creditAllowanceByAppId: Record<string, CreditAllowanceSummary> = {};
  try {
    creditAllowanceByAppId = await getPrepaidCreditBalancesByClientId(publicClientIds);
    const entries = Object.values(creditAllowanceByAppId);
    if (entries.length > 0) {
      let balanceUsdMicros = 0n;
      let lifetimeGrantedUsdMicros = 0n;
      let consumedUsdMicros = 0n;
      for (const row of entries) {
        balanceUsdMicros += BigInt(row.balanceUsdMicros);
        lifetimeGrantedUsdMicros += BigInt(row.lifetimeGrantedUsdMicros);
        consumedUsdMicros += BigInt(row.consumedUsdMicros);
      }
      creditAllowance = {
        hasAccess: balanceUsdMicros > 0n,
        balanceUsdMicros: balanceUsdMicros.toString(),
        lifetimeGrantedUsdMicros: lifetimeGrantedUsdMicros.toString(),
        consumedUsdMicros: consumedUsdMicros.toString(),
      };
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
  };
}
