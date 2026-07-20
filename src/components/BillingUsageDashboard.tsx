"use client";

import { useEffect, useMemo, useState, type ReactNode } from "react";
import Link from "next/link";
import { useSession } from "next-auth/react";
import DashboardLayout from "@/components/DashboardLayout";
import AppFilterDropdown from "@/components/AppFilterDropdown";
import AllowanceProgressBar from "@/components/AllowanceProgressBar";
import UsageBreakdownChart from "@/components/UsageBreakdownChart";
import SignedTicketRequestHistory from "@/components/SignedTicketRequestHistory";
import {
  AppUsageSection,
  BillingDashboardHeader,
} from "@/components/BillingUsageDashboard.helpers";
import type {
  BillingAppUsageSummary,
  BillingAppRow,
  BillingChartSeries,
} from "@/lib/billing-usage-dashboard-data";
import { formatUsdMicrosString } from "@/lib/format-usd-micros";
import type { OwnerBillingSubscriptionRow } from "@/lib/owner-billing-data";

/** Client-safe dashboard payload (bigints as strings). */
type BillingUsageDashboardClientPayload = {
  scope: "all" | "single";
  userId: string;
  role: string | undefined;
  isAdmin: boolean;
  usageSource: "openmeter";
  cycle: { start: string; end: string };
  orderedApps: BillingAppRow[];
  appUsage: BillingAppUsageSummary[];
  chartData: { date: string; value: number }[];
  chartSeries: BillingChartSeries[];
  totalRequests: number;
  totalFeeWei: string;
  totalNetworkFeeUsdMicros: string;
  appsWithUsage: number;
  activeSubscriptions?: OwnerBillingSubscriptionRow[];
};

type UsageTab = "mine" | "all";

type LoadState =
  | { status: "loading" }
  | { status: "error"; message: string; code?: number }
  | { status: "ready"; data: BillingUsageDashboardClientPayload };

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

function UsageLoadingShell({
  filterAppId,
  showingAll,
}: Readonly<{ filterAppId?: string | null; showingAll?: boolean }>) {
  const multi = !filterAppId;
  let loadingCopy = "Loading usage for this application…";
  if (multi && showingAll) {
    loadingCopy =
      "Loading usage across all platform apps — this can take a moment…";
  } else if (multi) {
    loadingCopy =
      "Loading usage across your apps — this can take a moment for multi-app views…";
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl sm:text-2xl font-bold text-zinc-100">Usage</h1>
        <p className="text-xs sm:text-sm text-zinc-500 mt-1">{loadingCopy}</p>
      </div>
      <div className="rounded-xl border border-zinc-800 bg-zinc-900/30 p-5 animate-pulse">
        <div className="h-3 w-36 rounded bg-zinc-800 mb-3" />
        <div className="h-2.5 w-48 rounded bg-zinc-800 mb-4" />
        <div className="h-1.5 w-full rounded bg-zinc-800 mb-6" />
        <div className="h-3 w-40 rounded bg-zinc-800 mb-4" />
        <div className="h-32 rounded bg-zinc-800/60" />
      </div>
    </div>
  );
}

function deriveFilteredView(
  data: BillingUsageDashboardClientPayload,
  selectedPublicClientIds: string[],
  historyScope: "own" | "all",
) {
  const allIds = data.orderedApps.map((a) => a.publicClientId);
  const allSelected =
    allIds.length > 0 && selectedPublicClientIds.length === allIds.length;
  const noneSelected = selectedPublicClientIds.length === 0;
  const selectedSet = new Set(selectedPublicClientIds);

  let filteredSeries = data.chartSeries;
  if (!allSelected) {
    filteredSeries = noneSelected
      ? []
      : data.chartSeries.filter((s) => selectedSet.has(s.appId));
  }

  let filteredAppUsage = data.appUsage;
  if (!allSelected) {
    filteredAppUsage = noneSelected
      ? []
      : data.appUsage.filter((e) => selectedSet.has(e.app.publicClientId));
  }
  filteredAppUsage = filteredAppUsage.filter((e) => e.requestCount > 0);

  // Admin All Usage + all apps selected: omit clientId filter so the platform
  // list is truly unrestricted (and avoids a huge id-set post-filter).
  // Subset selection still passes the dropdown ids. Own scope unchanged.
  let historyClientIds: string[];
  if (allSelected && historyScope === "all") {
    historyClientIds = [];
  } else if (allSelected) {
    historyClientIds = data.orderedApps.map((a) => a.publicClientId);
  } else {
    historyClientIds = selectedPublicClientIds;
  }

  return {
    filteredSeries,
    filteredAppUsage,
    historyClientIds,
  };
}

function ActiveSubscriptionSummary({
  subscriptions,
}: Readonly<{
  subscriptions: OwnerBillingSubscriptionRow[];
}>) {
  if (subscriptions.length === 0) {
    return (
      <div className="flex flex-col gap-2 rounded-lg border border-white/[0.05] bg-black/20 px-3 py-3 sm:flex-row sm:items-center sm:justify-between">
        <p className="text-xs text-zinc-500">
          No active subscription on your billing wallet yet.
        </p>
        <Link
          href="/billing"
          className="shrink-0 text-sm font-medium text-emerald-400 hover:text-emerald-300 transition-colors"
        >
          Open Billing →
        </Link>
      </div>
    );
  }

  const primary = subscriptions[0];
  const extras = subscriptions.length - 1;
  const usedLabel = formatUsdMicrosString(primary.usedUsdMicros, 4) ?? "$0";
  const allowanceMicros = primary.discountUsdMicros;
  const hasAllowance =
    allowanceMicros != null && BigInt(allowanceMicros) > 0n;
  const usageLine = hasAllowance
    ? `${primary.requestCount.toLocaleString()} requests this cycle`
    : `${usedLabel} this cycle · ${primary.requestCount.toLocaleString()} requests`;

  return (
    <div className="rounded-lg border border-white/[0.05] bg-black/20 px-3 py-3">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <p className="text-[10.5px] font-medium uppercase tracking-[0.06em] text-zinc-500">
            Active subscription
          </p>
          <p className="mt-1 truncate text-sm font-medium text-zinc-100">
            {primary.planName}
            {primary.appName ? (
              <span className="font-normal text-zinc-500"> · {primary.appName}</span>
            ) : null}
            {extras > 0 ? (
              <span className="font-normal text-zinc-600">
                {" "}
                · +{extras} more
              </span>
            ) : null}
          </p>
          <p className="mt-0.5 font-mono text-xs text-zinc-500">{usageLine}</p>
        </div>
        <Link
          href="/billing"
          className="shrink-0 text-sm font-medium text-emerald-400 hover:text-emerald-300 transition-colors"
        >
          View Billing →
        </Link>
      </div>
      {hasAllowance && allowanceMicros ? (
        <AllowanceProgressBar
          usedUsdMicros={primary.usedUsdMicros}
          allowanceUsdMicros={allowanceMicros}
          className="mt-3"
        />
      ) : null}
    </div>
  );
}

function emptyAppsMessage(
  selectedCount: number,
  isAdmin: boolean,
): string {
  if (selectedCount === 0) {
    return "Select at least one application.";
  }
  if (isAdmin) {
    return "No apps with usage this cycle.";
  }
  return "No apps with usage this cycle. Create an app or wait for traffic.";
}

function chartEmptyMessage(selectedCount: number): string {
  if (selectedCount === 0) {
    return "Select at least one application to view the chart.";
  }
  return "No usage in the current billing period yet.";
}

function SignedTicketsBlock({
  needsSelection,
  scope,
  historyScope,
  orderedApps,
  historyClientIds,
}: Readonly<{
  needsSelection: boolean;
  scope: "all" | "single";
  /** Viewer-own vs platform-wide admin history. */
  historyScope: "own" | "all";
  orderedApps: BillingAppRow[];
  historyClientIds: string[];
}>) {
  const isPlatform = historyScope === "all";
  const title = isPlatform
    ? "Signed ticket requests"
    : "Your signed ticket requests";
  if (needsSelection) {
    return (
      <section className="mb-6 sm:mb-8 rounded-xl border border-zinc-800 bg-zinc-900/30 p-4 sm:p-5">
        <h2 className="text-sm font-semibold text-zinc-200">{title}</h2>
        <p className="text-sm text-zinc-500 py-6 text-center">
          Select at least one application to view request history.
        </p>
      </section>
    );
  }
  return (
    <div className="mb-6 sm:mb-8">
      <SignedTicketRequestHistory
        clientId={scope === "single" ? orderedApps[0]?.publicClientId : null}
        clientIds={scope === "single" ? null : historyClientIds}
        historyScope={historyScope}
      />
    </div>
  );
}

function AppUsageList({
  entries,
  scope,
  isAdmin,
  isOpenMeter,
  userId,
  emptyMessage,
}: Readonly<{
  entries: BillingAppUsageSummary[];
  scope: "all" | "single";
  isAdmin: boolean;
  isOpenMeter: boolean;
  userId: string;
  emptyMessage: string;
}>) {
  if (entries.length === 0) {
    return (
      <div className="rounded-xl border border-zinc-800 bg-zinc-900/30 p-6 text-center">
        <p className="text-zinc-300 font-medium">No applications to show</p>
        <p className="text-zinc-500 text-sm mt-1">{emptyMessage}</p>
      </div>
    );
  }
  return (
    <div>
      <div className="mb-3">
        <h2 className="text-sm font-semibold text-zinc-200">
          Per-application breakdown
        </h2>
        <p className="text-xs text-zinc-500 mt-1">
          Summary rows stay collapsed; expand an app for identity detail.
        </p>
      </div>
      <div className="space-y-3">
        {entries.map((entry) => (
          <AppUsageSection
            key={entry.app.id}
            entry={entry}
            scope={scope}
            isAdmin={isAdmin}
            isOpenMeter={isOpenMeter}
            userId={userId}
          />
        ))}
      </div>
    </div>
  );
}

function BillingUsageBody({
  data,
  showTabs,
  activeTab,
  onSelectTab,
}: Readonly<{
  data: BillingUsageDashboardClientPayload;
  showTabs: boolean;
  activeTab: UsageTab;
  onSelectTab: (tab: UsageTab) => void;
}>) {
  const {
    scope,
    userId,
    isAdmin,
    usageSource,
    cycle,
    orderedApps,
  } = data;

  const isOpenMeter = usageSource === "openmeter";
  const singleAppName = scope === "single" ? orderedApps[0]?.name : null;
  const isMultiApp = scope !== "single";

  const filterOptions = useMemo(
    () =>
      orderedApps.map((app) => ({
        value: app.publicClientId,
        label: app.name,
      })),
    [orderedApps],
  );

  const allPublicClientIds = useMemo(
    () => filterOptions.map((o) => o.value),
    [filterOptions],
  );
  const allIdsKey = allPublicClientIds.join("\0");

  const [selectedAppIds, setSelectedAppIds] = useState<string[]>(() =>
    allPublicClientIds,
  );
  const [prevAllIdsKey, setPrevAllIdsKey] = useState(allIdsKey);

  // Reset selection when the loaded app set changes (tab switch / reload).
  // Adjust during render — avoids setState-in-effect cascading renders.
  if (prevAllIdsKey !== allIdsKey) {
    setPrevAllIdsKey(allIdsKey);
    setSelectedAppIds(allIdsKey.length > 0 ? allIdsKey.split("\0") : []);
  }

  const historyScope: "own" | "all" =
    showTabs && activeTab === "all" ? "all" : "own";
  const derived = deriveFilteredView(data, selectedAppIds, historyScope);
  const periodCopy =
    activeTab === "all" && showTabs
      ? "Platform-wide usage for the current cycle."
      : "Usage for apps you own or administer.";

  return (
    <>
      <div className="mb-6 sm:mb-8 flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <BillingDashboardHeader
          scope={scope}
          singleAppName={singleAppName}
          cycle={cycle}
          isOpenMeter={isOpenMeter}
        />
        {showTabs ? (
          <div className="flex shrink-0 items-center gap-1 self-start rounded-lg bg-black/20 p-0.5">
            <TabButton active={activeTab === "mine"} onClick={() => onSelectTab("mine")}>
              My Usage
            </TabButton>
            <TabButton active={activeTab === "all"} onClick={() => onSelectTab("all")}>
              All Usage
            </TabButton>
          </div>
        ) : null}
      </div>

      <div className="mb-6 sm:mb-8 rounded-xl border border-white/[0.06] bg-white/[0.02] backdrop-blur-sm p-5">
        <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <h3 className="font-semibold text-zinc-100">This billing period</h3>
            <p className="text-xs text-zinc-500 mt-1">{periodCopy}</p>
          </div>
          {isMultiApp && filterOptions.length > 0 ? (
            <AppFilterDropdown
              options={filterOptions}
              selectedValues={selectedAppIds}
              onChange={setSelectedAppIds}
            />
          ) : null}
        </div>

        {activeTab === "mine" || !showTabs ? (
          <div className="mb-5">
            <ActiveSubscriptionSummary
              subscriptions={data.activeSubscriptions ?? []}
            />
          </div>
        ) : null}

        <div>
          <h4 className="text-sm font-medium text-zinc-200 mb-1">
            Usage over billing period
          </h4>
          <p className="text-xs text-zinc-500 mb-4">
            Each series is one app × pipeline/model (requests per day).
          </p>
          {derived.filteredSeries.length === 0 ? (
            <p className="text-sm text-zinc-500">
              {chartEmptyMessage(selectedAppIds.length)}
            </p>
          ) : (
            <UsageBreakdownChart
              series={derived.filteredSeries}
              valueLabel="Requests / day"
              height={220}
              maxSeries={12}
            />
          )}
        </div>
      </div>

      <SignedTicketsBlock
        needsSelection={selectedAppIds.length === 0 && isMultiApp}
        scope={scope}
        historyScope={historyScope}
        orderedApps={orderedApps}
        historyClientIds={derived.historyClientIds}
      />

      <AppUsageList
        entries={derived.filteredAppUsage}
        scope={scope}
        isAdmin={isAdmin}
        isOpenMeter={isOpenMeter}
        userId={userId}
        emptyMessage={emptyAppsMessage(selectedAppIds.length, isAdmin)}
      />
    </>
  );
}

/**
 * Usage page shell that paints immediately, then loads OpenMeter-backed data.
 * Admins get My Usage / All Usage tabs; developers always see own apps.
 */
export default function BillingUsageDashboard({
  filterAppId,
  fundPanel,
}: Readonly<{
  filterAppId?: string | null;
  /** Optional MoonPay / prepaid top-up panel (app owners on pay-per-use). */
  fundPanel?: ReactNode;
}>) {
  const { data: session } = useSession();
  const role = (session?.user as Record<string, unknown> | undefined)?.role as
    | string
    | undefined;
  const isAdmin = role === "admin";
  const showTabs = isAdmin && !filterAppId;

  const [activeTab, setActiveTab] = useState<UsageTab>("mine");
  const [state, setState] = useState<LoadState>({ status: "loading" });
  const [retryToken, setRetryToken] = useState(0);

  useEffect(() => {
    let cancelled = false;

    void (async () => {
      setState({ status: "loading" });

      const params = new URLSearchParams();
      if (filterAppId) {
        params.set("appId", filterAppId);
      } else if (showTabs && activeTab === "all") {
        params.set("scope", "all");
      } else {
        params.set("scope", "own");
      }
      const url = `/api/v1/billing/dashboard?${params.toString()}`;

      try {
        const r = await fetch(url);
        if (r.status === 401) {
          throw Object.assign(
            new Error("Please sign in to view billing and usage."),
            { code: 401 },
          );
        }
        if (r.status === 403 || r.status === 404) {
          throw Object.assign(new Error("Usage not found."), { code: r.status });
        }
        if (!r.ok) {
          throw Object.assign(new Error("Usage unavailable right now."), {
            code: r.status,
          });
        }
        const data = (await r.json()) as BillingUsageDashboardClientPayload;
        if (!cancelled) setState({ status: "ready", data });
      } catch (err) {
        if (!cancelled) {
          const e = err as Error & { code?: number };
          setState({
            status: "error",
            message: e.message || "Usage unavailable",
            code: e.code,
          });
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [filterAppId, activeTab, retryToken, showTabs]);

  return (
    <DashboardLayout>
      {fundPanel}
      {state.status === "loading" ? (
        <>
          {showTabs ? (
            <div className="mb-4 flex justify-end">
              <div className="flex shrink-0 items-center gap-1 rounded-lg bg-black/20 p-0.5">
                <TabButton
                  active={activeTab === "mine"}
                  onClick={() => setActiveTab("mine")}
                >
                  My Usage
                </TabButton>
                <TabButton
                  active={activeTab === "all"}
                  onClick={() => setActiveTab("all")}
                >
                  All Usage
                </TabButton>
              </div>
            </div>
          ) : null}
          <UsageLoadingShell
            filterAppId={filterAppId}
            showingAll={activeTab === "all"}
          />
        </>
      ) : null}

      {state.status === "error" ? (
        <div className="text-center py-12">
          <h2 className="text-lg font-medium text-zinc-300">
            {state.code === 401 ? "Billing unavailable" : "Usage unavailable"}
          </h2>
          <p className="text-zinc-500 mt-2">{state.message}</p>
          {state.code !== 401 ? (
            <button
              type="button"
              onClick={() => setRetryToken((n) => n + 1)}
              className="mt-4 text-sm text-emerald-400 hover:text-emerald-300"
            >
              Retry
            </button>
          ) : null}
        </div>
      ) : null}

      {state.status === "ready" ? (
        <BillingUsageBody
          data={state.data}
          showTabs={showTabs}
          activeTab={activeTab}
          onSelectTab={setActiveTab}
        />
      ) : null}
    </DashboardLayout>
  );
}
