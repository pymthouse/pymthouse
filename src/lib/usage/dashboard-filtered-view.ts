import type {
  BillingAppUsageSummary,
  BillingChartSeries,
} from "@/lib/billing-usage-dashboard-data";

export type ChartDimension = "pipeline" | "identity";

export type DashboardFilterSource = {
  orderedApps: { publicClientId: string }[];
  chartSeries: BillingChartSeries[];
  chartSeriesByIdentity: BillingChartSeries[];
  appUsage: BillingAppUsageSummary[];
};

function applyAppSelection<T>(
  items: T[],
  allSelected: boolean,
  noneSelected: boolean,
  belongsToSelectedApp: (item: T) => boolean,
): T[] {
  if (allSelected) return items;
  if (noneSelected) return [];
  return items.filter(belongsToSelectedApp);
}

/** Identity series carry the identity in `jobType`; pipeline/model series stay app-filtered. */
function applyIdentitySeriesFilter(
  series: BillingChartSeries[],
  chartDimension: ChartDimension,
  allIdentitiesSelected: boolean,
  identitySet: Set<string>,
): BillingChartSeries[] {
  if (chartDimension !== "identity" || allIdentitiesSelected) {
    return series;
  }
  return series.filter((s) => identitySet.has(s.jobType));
}

function restrictAppUsageToIdentities(
  entry: BillingAppUsageSummary,
  identitySet: Set<string>,
): BillingAppUsageSummary {
  const byUser = entry.byUser.filter((u) =>
    identitySet.has(u.externalUserId ?? u.endUserId),
  );
  const requestCount = byUser.reduce((sum, u) => sum + u.requestCount, 0);
  const networkFeeUsdMicros = byUser
    .reduce((sum, u) => sum + BigInt(u.networkFeeUsdMicros || "0"), 0n)
    .toString();
  return {
    ...entry,
    byUser,
    requestCount,
    networkFeeUsdMicros,
    endUserBillableUsdMicros: networkFeeUsdMicros,
  };
}

function applyIdentityAppUsageFilter(
  appUsage: BillingAppUsageSummary[],
  allIdentitiesSelected: boolean,
  identitySet: Set<string>,
): BillingAppUsageSummary[] {
  if (allIdentitiesSelected) return appUsage;
  return appUsage
    .map((entry) => restrictAppUsageToIdentities(entry, identitySet))
    .filter((entry) => entry.byUser.length > 0);
}

/**
 * Admin All Usage + all apps selected: omit clientId filter so request
 * history uses the unrestricted platform event list. Subset selection still
 * passes the dropdown ids. Own scope always sends the selected (or all) ids.
 */
export function historyClientIdsForView(
  allSelected: boolean,
  historyScope: "own" | "all",
  allPublicClientIds: string[],
  selectedPublicClientIds: string[],
): string[] {
  if (!allSelected) return selectedPublicClientIds;
  if (historyScope === "all") return [];
  return allPublicClientIds;
}

export function deriveFilteredView(
  data: DashboardFilterSource,
  selectedPublicClientIds: string[],
  historyScope: "own" | "all",
  chartDimension: ChartDimension,
  selectedIdentityIds: string[],
  allIdentityIds: string[],
) {
  const allIds = data.orderedApps.map((a) => a.publicClientId);
  const allSelected =
    allIds.length > 0 && selectedPublicClientIds.length === allIds.length;
  const noneSelected = selectedPublicClientIds.length === 0;
  const selectedSet = new Set(selectedPublicClientIds);

  const allIdentitiesSelected =
    allIdentityIds.length === 0 ||
    selectedIdentityIds.length === allIdentityIds.length;
  const identitySet = new Set(selectedIdentityIds);

  const baseSeries =
    chartDimension === "identity" ? data.chartSeriesByIdentity : data.chartSeries;

  const filteredSeries = applyIdentitySeriesFilter(
    applyAppSelection(baseSeries, allSelected, noneSelected, (s) =>
      selectedSet.has(s.appId),
    ),
    chartDimension,
    allIdentitiesSelected,
    identitySet,
  );

  const filteredAppUsage = applyIdentityAppUsageFilter(
    applyAppSelection(data.appUsage, allSelected, noneSelected, (e) =>
      selectedSet.has(e.app.publicClientId),
    ),
    allIdentitiesSelected,
    identitySet,
  ).filter((e) => e.requestCount > 0);

  return {
    filteredSeries,
    filteredAppUsage,
    historyClientIds: historyClientIdsForView(
      allSelected,
      historyScope,
      allIds,
      selectedPublicClientIds,
    ),
    // Request history covers every identity unless the filter narrows it.
    historyIdentityIds: allIdentitiesSelected ? [] : selectedIdentityIds,
  };
}
