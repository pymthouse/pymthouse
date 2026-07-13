"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import AllowanceStrip from "@/components/AllowanceStrip";
import AppFilterDropdown from "@/components/AppFilterDropdown";
import InfoTooltip from "@/components/InfoTooltip";
import SignedTicketRequestHistory from "@/components/SignedTicketRequestHistory";
import UsageBreakdownChart from "@/components/UsageBreakdownChart";
import UsageMetricCell from "@/components/UsageMetricCell";
import { formatBillingPeriod, formatPeriodResetLabel } from "@/lib/billing-format";
import type { DashboardUsageSummary } from "@/lib/dashboard-usage-summary";
import { formatUsdMicrosString } from "@/lib/format-usd-micros";

export type DeveloperDashboardAppOption = {
  /** Public OIDC client_id — matches chartSeries.appId / feesByAppId keys. */
  publicClientId: string;
  name: string;
};

type ChartSeries = DashboardUsageSummary["chartSeries"];

function deriveFilteredUsage(
  summary: DashboardUsageSummary,
  selectedPublicClientIds: string[],
  allPublicClientIds: string[],
) {
  const allSelected =
    allPublicClientIds.length > 0 &&
    selectedPublicClientIds.length === allPublicClientIds.length;
  const noneSelected = selectedPublicClientIds.length === 0;
  const selectedSet = new Set(selectedPublicClientIds);

  let filteredSeries: ChartSeries = summary.chartSeries;
  if (!allSelected) {
    filteredSeries = noneSelected
      ? []
      : summary.chartSeries.filter((s) => selectedSet.has(s.appId));
  }

  const filteredRequests = filteredSeries.reduce((sum, s) => sum + s.totalRequests, 0);

  const appsWithSeries = new Set(filteredSeries.map((s) => s.appId));
  const filteredAppsWithUsage = appsWithSeries.size;

  let filteredAppsCount = summary.appsCount;
  if (!allSelected) {
    filteredAppsCount = selectedPublicClientIds.length;
  }

  let totalFeesMicros = 0n;
  if (allSelected) {
    totalFeesMicros = BigInt(summary.totalNetworkFeeUsdMicros || "0");
  } else {
    for (const id of selectedPublicClientIds) {
      totalFeesMicros += BigInt(summary.feesByAppId[id] ?? "0");
    }
  }

  return {
    allSelected,
    filteredSeries,
    filteredRequests,
    filteredAppsWithUsage,
    filteredAppsCount,
    totalFeesLabel: formatUsdMicrosString(totalFeesMicros.toString(), 4) ?? "$0",
  };
}

function DashboardUsageChart({
  appsCount,
  chartSeries,
}: Readonly<{
  appsCount: number;
  chartSeries: ChartSeries;
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
 * Developer Dashboard usage: multi-select app filter, metrics/chart, prepaid
 * credits when exactly one app is selected, and signed-ticket request history.
 */
export default function DeveloperDashboardUsage({
  summary,
  apps,
}: Readonly<{
  summary: DashboardUsageSummary;
  apps: DeveloperDashboardAppOption[];
}>) {
  const filterOptions = useMemo(
    () =>
      apps
        .filter((app) => app.publicClientId.trim().length > 0)
        .map((app) => ({
          value: app.publicClientId,
          label: app.name,
        })),
    [apps],
  );

  const allPublicClientIds = useMemo(
    () => filterOptions.map((o) => o.value),
    [filterOptions],
  );

  const [selectedAppIds, setSelectedAppIds] = useState<string[]>(allPublicClientIds);

  const {
    cycle,
    creditAllowanceByAppId,
  } = summary;

  const derived = deriveFilteredUsage(summary, selectedAppIds, allPublicClientIds);

  const singleSelectedId =
    selectedAppIds.length === 1 ? selectedAppIds[0] : null;
  const singleAppCredits =
    singleSelectedId != null
      ? creditAllowanceByAppId[singleSelectedId] ?? null
      : null;
  const singleAppName =
    singleSelectedId != null
      ? filterOptions.find((o) => o.value === singleSelectedId)?.label
      : null;

  const historyClientIds = derived.allSelected ? null : selectedAppIds;

  const periodTooltip = [
    `${formatBillingPeriod(cycle.start)} — ${formatBillingPeriod(cycle.end)}`,
    `Resets ${formatPeriodResetLabel(cycle.end)}`,
    "Apps you own or administer",
  ].join("\n");

  return (
    <div>
      <div className="rounded-xl border border-white/[0.06] bg-white/[0.02] backdrop-blur-sm p-5">
        <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div className="flex items-center gap-1.5">
            <h3 className="font-semibold text-zinc-100">Your usage this billing period</h3>
            <InfoTooltip label={periodTooltip} wide />
          </div>
          <div className="flex flex-wrap items-center gap-3">
            {filterOptions.length > 0 ? (
              <AppFilterDropdown
                options={filterOptions}
                selectedValues={selectedAppIds}
                onChange={setSelectedAppIds}
              />
            ) : null}
            <Link
              href="/billing"
              className="shrink-0 text-sm text-emerald-400 hover:text-emerald-300 transition-colors"
            >
              View full usage
            </Link>
          </div>
        </div>

        {singleAppCredits ? (
          <AllowanceStrip
            balanceUsdMicros={singleAppCredits.balanceUsdMicros}
            lifetimeGrantedUsdMicros={singleAppCredits.lifetimeGrantedUsdMicros}
            consumedUsdMicros={singleAppCredits.consumedUsdMicros}
            requestCount={derived.filteredRequests}
            scopeHint={
              singleAppName
                ? `Prepaid credits for ${singleAppName} (per application — sum of end-user wallets).`
                : "Prepaid credits for this application (sum of end-user wallets)."
            }
          />
        ) : null}

        <div className="mb-5 grid grid-cols-3 gap-4 rounded-lg border border-white/[0.05] bg-black/20 px-3 py-3">
          <UsageMetricCell
            label="Apps"
            value={String(derived.filteredAppsCount)}
            sub={`${derived.filteredAppsWithUsage} with usage`}
          />
          <UsageMetricCell
            label="Requests"
            value={String(derived.filteredRequests)}
            sub="this cycle"
          />
          <UsageMetricCell
            label="Network fees"
            value={derived.totalFeesLabel}
            sub="USD from usage events this cycle"
            title={derived.totalFeesLabel}
          />
        </div>

        <DashboardUsageChart
          appsCount={summary.appsCount}
          chartSeries={derived.filteredSeries}
        />
      </div>

      {selectedAppIds.length === 0 && filterOptions.length > 0 ? (
        <section className="mt-8 sm:mt-10 rounded-xl border border-zinc-800 bg-zinc-900/30 p-4 sm:p-5">
          <h2 className="text-sm font-semibold text-zinc-200">Your signed ticket requests</h2>
          <p className="text-sm text-zinc-500 py-6 text-center">
            Select at least one application to view request history.
          </p>
        </section>
      ) : (
        <SignedTicketRequestHistory clientIds={historyClientIds} />
      )}
    </div>
  );
}
