"use client";

import { useState } from "react";
import AllowanceStrip from "@/components/AllowanceStrip";
import InfoTooltip from "@/components/InfoTooltip";
import UsageBreakdownChart from "@/components/UsageBreakdownChart";
import UsageMetricCell from "@/components/UsageMetricCell";
import { formatBillingPeriod, formatPeriodResetLabel } from "@/lib/billing-format";
import type { DashboardUsageSummary } from "@/lib/dashboard-usage-summary";
import { formatUsdMicros } from "@/lib/format-usd";

export type AdminPlatformStat = {
  label: string;
  value: string;
  sub: string;
  live?: boolean;
};

type UsageTab = "mine" | "all";

type ChartSeries = DashboardUsageSummary["chartSeries"];

function TabButton({
  active,
  onClick,
  children,
}: Readonly<{ active: boolean; onClick: () => void; children: React.ReactNode }>) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition-colors ${
        active
          ? "bg-emerald-500/15 text-emerald-400 shadow-[inset_0_0_0_1px_rgba(52,211,153,0.25)]"
          : "text-zinc-500 hover:text-zinc-300 hover:bg-white/[0.04]"
      }`}
    >
      {children}
    </button>
  );
}

function MetricsSkeleton() {
  return (
    <>
      {["a", "b", "c"].map((key) => (
        <div key={key} className="min-w-0 animate-pulse space-y-2">
          <div className="h-2.5 w-16 rounded bg-zinc-800" />
          <div className="h-5 w-12 rounded bg-zinc-800" />
        </div>
      ))}
    </>
  );
}

function SharedRequestFeeCells({
  filterAppId,
  filteredRequests,
  totalRequests,
  totalFeesLabel,
}: Readonly<{
  filterAppId: string | null;
  filteredRequests: number;
  totalRequests: number;
  totalFeesLabel: string;
}>) {
  return (
    <>
      <UsageMetricCell
        label="Requests"
        value={String(filterAppId ? filteredRequests : totalRequests)}
        sub="this cycle"
      />
      <UsageMetricCell
        label="Network fees"
        value={totalFeesLabel}
        sub="USD from usage events this cycle"
        title={totalFeesLabel}
      />
    </>
  );
}

function appsMetricSub(
  filterAppId: string | null,
  filteredAppsWithUsage: number,
): string {
  if (!filterAppId) {
    return `${filteredAppsWithUsage} with usage`;
  }
  if (filteredAppsWithUsage) {
    return "with usage";
  }
  return "no usage this cycle";
}

function UsageMetricsGrid({
  loading,
  summary,
  showingAll,
  volumeStat,
  filterAppId,
  filteredRequests,
  filteredAppsCount,
  filteredAppsWithUsage,
  totalFeesLabel,
}: Readonly<{
  loading: boolean;
  summary: DashboardUsageSummary | null;
  showingAll: boolean;
  volumeStat: AdminPlatformStat;
  filterAppId: string | null;
  filteredRequests: number;
  filteredAppsCount: number;
  filteredAppsWithUsage: number;
  totalFeesLabel: string;
}>) {
  let cells: React.ReactNode = <MetricsSkeleton />;

  if (!loading && summary) {
    const shared = (
      <SharedRequestFeeCells
        filterAppId={filterAppId}
        filteredRequests={filteredRequests}
        totalRequests={summary.totalRequests}
        totalFeesLabel={totalFeesLabel}
      />
    );

    if (showingAll) {
      cells = (
        <>
          <UsageMetricCell
            label={volumeStat.label}
            value={filterAppId ? "—" : volumeStat.value}
            sub={
              filterAppId
                ? "platform volume · clear app filter to see total"
                : volumeStat.sub
            }
            live={filterAppId ? false : volumeStat.live}
          />
          {shared}
        </>
      );
    } else {
      cells = (
        <>
          <UsageMetricCell
            label="Apps"
            value={String(filteredAppsCount)}
            sub={appsMetricSub(filterAppId, filteredAppsWithUsage)}
          />
          {shared}
        </>
      );
    }
  }

  return (
    <div className="mb-5 grid grid-cols-3 gap-4 rounded-lg border border-white/[0.05] bg-black/20 px-3 py-3">
      {cells}
    </div>
  );
}

function emptyAppsMessage(showingAll: boolean): string {
  if (showingAll) {
    return "No apps to show usage for yet.";
  }
  return "Create an app to start tracking your personal usage here.";
}

function UsageChartArea({
  loading,
  summary,
  showingAll,
  filterAppId,
  filterAppName,
  filteredSeries,
}: Readonly<{
  loading: boolean;
  summary: DashboardUsageSummary | null;
  showingAll: boolean;
  filterAppId: string | null;
  filterAppName: string | null;
  filteredSeries: ChartSeries;
}>) {
  if (loading || !summary) {
    return <div className="h-28 animate-pulse rounded bg-zinc-800/60" />;
  }

  if (summary.appsCount === 0) {
    return <p className="text-sm text-zinc-500">{emptyAppsMessage(showingAll)}</p>;
  }

  if (filteredSeries.length === 0 && filterAppId) {
    return (
      <p className="text-sm text-zinc-500">
        No usage for {filterAppName ?? "this app"} in the current billing period.
      </p>
    );
  }

  return (
    <UsageBreakdownChart
      series={filteredSeries}
      valueLabel="Requests / day"
      height={160}
    />
  );
}

function UsagePanelHeader({
  showingAll,
  summary,
  filterAppId,
  filterAppName,
  onClearAppFilter,
  onSelectTab,
}: Readonly<{
  showingAll: boolean;
  summary: DashboardUsageSummary | null;
  filterAppId: string | null;
  filterAppName: string | null;
  onClearAppFilter?: () => void;
  onSelectTab: (tab: UsageTab) => void;
}>) {
  const title = showingAll ? "All Usage" : "My Usage";
  const scopeHint = showingAll
    ? "All apps on the platform"
    : "Apps you own or administer";
  const showFilterChip = Boolean(filterAppId && filterAppName);

  let periodTooltip: string | null = null;
  if (summary) {
    periodTooltip = [
      `${formatBillingPeriod(summary.cycle.start)} — ${formatBillingPeriod(summary.cycle.end)}`,
      `Resets ${formatPeriodResetLabel(summary.cycle.end)}`,
      scopeHint,
    ].join("\n");
  }

  return (
    <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
      <div className="min-w-0">
        <div className="flex items-center gap-1.5">
          <h3 className="font-semibold text-zinc-100">{title}</h3>
          {periodTooltip ? <InfoTooltip label={periodTooltip} wide /> : null}
        </div>
        {showFilterChip ? (
          <div className="mt-2 inline-flex items-center gap-2 rounded-lg border border-emerald-500/25 bg-emerald-500/10 px-2.5 py-1 text-xs text-emerald-300">
            <span>
              Filtered to <span className="font-medium text-emerald-200">{filterAppName}</span>
            </span>
            {onClearAppFilter ? (
              <button
                type="button"
                onClick={onClearAppFilter}
                className="rounded px-1 text-emerald-400/80 hover:bg-emerald-500/20 hover:text-emerald-200"
                aria-label="Clear app filter"
              >
                ✕
              </button>
            ) : null}
          </div>
        ) : null}
      </div>
      <div className="flex shrink-0 items-center gap-1 self-start rounded-lg bg-black/20 p-0.5 sm:ml-auto">
        <TabButton active={!showingAll} onClick={() => onSelectTab("mine")}>
          My Usage
        </TabButton>
        <TabButton active={showingAll} onClick={() => onSelectTab("all")}>
          All Usage
        </TabButton>
      </div>
    </div>
  );
}

function UsagePanelBody({
  failed,
  loading,
  summary,
  showingAll,
  volumeStat,
  filterAppId,
  filterAppName,
  filteredSeries,
  filteredRequests,
  filteredAppsCount,
  filteredAppsWithUsage,
  totalFeesLabel,
  onRetryAllUsage,
}: Readonly<{
  failed: boolean;
  loading: boolean;
  summary: DashboardUsageSummary | null;
  showingAll: boolean;
  volumeStat: AdminPlatformStat;
  filterAppId: string | null;
  filterAppName: string | null;
  filteredSeries: ChartSeries;
  filteredRequests: number;
  filteredAppsCount: number;
  filteredAppsWithUsage: number;
  totalFeesLabel: string;
  onRetryAllUsage: () => void;
}>) {
  if (failed) {
    return (
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
    );
  }

  const showAllowance =
    !loading && !showingAll && !filterAppId && summary != null;

  return (
    <>
      {showAllowance ? (
        <AllowanceStrip
          consumedUsdMicros={summary.totalNetworkFeeUsdMicros}
          requestCount={summary.totalRequests}
        />
      ) : null}
      <UsageMetricsGrid
        loading={loading}
        summary={summary}
        showingAll={showingAll}
        volumeStat={volumeStat}
        filterAppId={filterAppId}
        filteredRequests={filteredRequests}
        filteredAppsCount={filteredAppsCount}
        filteredAppsWithUsage={filteredAppsWithUsage}
        totalFeesLabel={totalFeesLabel}
      />
      <UsageChartArea
        loading={loading}
        summary={summary}
        showingAll={showingAll}
        filterAppId={filterAppId}
        filterAppName={filterAppName}
        filteredSeries={filteredSeries}
      />
    </>
  );
}

function deriveFilteredUsage(
  summary: DashboardUsageSummary | null,
  filterAppId: string | null,
) {
  let filteredSeries: ChartSeries = summary?.chartSeries ?? [];
  if (summary && filterAppId) {
    filteredSeries = summary.chartSeries.filter((s) => s.appId === filterAppId);
  }

  const filteredRequests = filteredSeries.reduce((sum, s) => sum + s.totalRequests, 0);

  let filteredAppsWithUsage = summary?.appsWithUsage ?? 0;
  if (filterAppId) {
    if (filteredSeries.length > 0) {
      filteredAppsWithUsage = 1;
    } else {
      filteredAppsWithUsage = 0;
    }
  }

  let filteredAppsCount = summary?.appsCount ?? 0;
  if (filterAppId) {
    filteredAppsCount = 1;
  }

  let totalFeesLabel = "$0";
  if (summary) {
    if (filterAppId) {
      totalFeesLabel =
        formatUsdMicros(summary.feesByAppId[filterAppId] ?? "0", 6) ?? "$0";
    } else {
      totalFeesLabel = formatUsdMicros(summary.totalNetworkFeeUsdMicros, 6) ?? "$0";
    }
  }

  return {
    filteredSeries,
    filteredRequests,
    filteredAppsWithUsage,
    filteredAppsCount,
    totalFeesLabel,
  };
}

/**
 * Admin Dashboard usage panel. My Usage / All Usage is independent of the
 * Apps section's All apps toggle. All Usage shows volume + request + fee
 * metrics in one row (USD fees from usage events). Chart series are
 * app × pipeline/model constraint, optionally filtered to a selected app from the list below.
 */
export default function AdminUsagePanel({
  initialOwnUsage,
  allUsage,
  loadingAllUsage,
  allUsageError,
  onEnsureAllUsage,
  onRetryAllUsage,
  volumeStat,
  filterAppId = null,
  filterAppName = null,
  onClearAppFilter,
}: Readonly<{
  initialOwnUsage: DashboardUsageSummary | null;
  allUsage: DashboardUsageSummary | null;
  loadingAllUsage: boolean;
  allUsageError: boolean;
  onEnsureAllUsage: () => void;
  onRetryAllUsage: () => void;
  volumeStat: AdminPlatformStat;
  filterAppId?: string | null;
  filterAppName?: string | null;
  onClearAppFilter?: () => void;
}>) {
  const [activeTab, setActiveTab] = useState<UsageTab>("mine");

  if (!initialOwnUsage) {
    return null;
  }

  const showingAll = activeTab === "all";
  const summary = showingAll ? allUsage : initialOwnUsage;
  const loading = showingAll && summary === null && loadingAllUsage;
  const failed = showingAll && allUsageError && !loadingAllUsage;
  const derived = deriveFilteredUsage(summary, filterAppId);

  const selectTab = (tab: UsageTab) => {
    setActiveTab(tab);
    if (tab === "all") onEnsureAllUsage();
  };

  return (
    <div className="rounded-xl border border-white/[0.06] bg-white/[0.02] backdrop-blur-sm p-5">
      <UsagePanelHeader
        showingAll={showingAll}
        summary={summary}
        filterAppId={filterAppId}
        filterAppName={filterAppName}
        onClearAppFilter={onClearAppFilter}
        onSelectTab={selectTab}
      />
      <UsagePanelBody
        failed={failed}
        loading={loading}
        summary={summary}
        showingAll={showingAll}
        volumeStat={volumeStat}
        filterAppId={filterAppId}
        filterAppName={filterAppName}
        filteredSeries={derived.filteredSeries}
        filteredRequests={derived.filteredRequests}
        filteredAppsCount={derived.filteredAppsCount}
        filteredAppsWithUsage={derived.filteredAppsWithUsage}
        totalFeesLabel={derived.totalFeesLabel}
        onRetryAllUsage={onRetryAllUsage}
      />
    </div>
  );
}
