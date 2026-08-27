"use client";

import { useEffect, useMemo, useState, type ReactNode } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useSession } from "next-auth/react";
import DashboardLayout from "@/components/DashboardLayout";
import AppFilterDropdown from "@/components/AppFilterDropdown";
import AllowanceProgressBar from "@/components/AllowanceProgressBar";
import CostWaterfall from "@/components/billing/CostWaterfall";
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
import { resolveOwnerBillingPressure } from "@/lib/billing/owner-billing-pressure";
import { formatUsdMicrosSummary } from "@/lib/format-usd-micros";
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
  chartSeriesByIdentity: BillingChartSeries[];
  totalRequests: number;
  totalFeeWei: string;
  totalNetworkFeeUsdMicros: string;
  appsWithUsage: number;
  activeSubscriptions?: OwnerBillingSubscriptionRow[];
  creditBalanceUsdMicros?: string | null;
  defaultPaymentMethod?: { brand?: string | null; last4?: string | null } | null;
};

type UsageTab = "mine" | "all";

/** Chart series split: app × pipeline/model (default) or app × identity. */
type ChartDimension = "pipeline" | "identity";

type LoadState =
  | { status: "loading" }
  | { status: "error"; message: string; code?: number }
  | { status: "ready"; data: BillingUsageDashboardClientPayload };

function TabLink({
  active,
  href,
  children,
}: Readonly<{ active: boolean; href: string; children: React.ReactNode }>) {
  return (
    <Link
      href={href}
      aria-current={active ? "page" : undefined}
      className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition-colors ${
        active
          ? "bg-emerald-500/15 text-emerald-400 shadow-[inset_0_0_0_1px_rgba(52,211,153,0.25)]"
          : "text-zinc-500 hover:text-zinc-300 hover:bg-white/[0.04]"
      }`}
    >
      {children}
    </Link>
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

  let filteredSeries = baseSeries;
  if (!allSelected) {
    filteredSeries = noneSelected
      ? []
      : baseSeries.filter((s) => selectedSet.has(s.appId));
  }
  // Identity series carry the identity in `jobType`, so the filter applies only
  // to that dimension; pipeline/model series stay app-filtered.
  if (chartDimension === "identity" && !allIdentitiesSelected) {
    filteredSeries = filteredSeries.filter((s) => identitySet.has(s.jobType));
  }

  let filteredAppUsage = data.appUsage;
  if (!allSelected) {
    filteredAppUsage = noneSelected
      ? []
      : data.appUsage.filter((e) => selectedSet.has(e.app.publicClientId));
  }
  if (!allIdentitiesSelected) {
    filteredAppUsage = filteredAppUsage
      .map((entry) => {
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
      })
      .filter((entry) => entry.byUser.length > 0);
  }
  filteredAppUsage = filteredAppUsage.filter((e) => e.requestCount > 0);

  // Admin All Usage + all apps selected: omit clientId filter so request
  // history uses the unrestricted platform event list (avoids a huge id-set
  // post-filter). Session list discovers apps from those events server-side.
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
    // Request history covers every identity unless the filter narrows it.
    historyIdentityIds: allIdentitiesSelected ? [] : selectedIdentityIds,
  };
}

function ActiveSubscriptionSummary({
  subscriptions,
  creditBalanceUsdMicros,
  defaultPaymentMethod,
}: Readonly<{
  subscriptions: OwnerBillingSubscriptionRow[];
  creditBalanceUsdMicros: string | null;
  defaultPaymentMethod: { brand?: string | null; last4?: string | null } | null;
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
  const allowanceMicros = primary.discountUsdMicros;
  const hasAllowance =
    allowanceMicros != null && BigInt(allowanceMicros) > 0n;
  // Requests and dollars are separate quantities — render both explicitly
  // rather than letting one percentage stand in for the other.
  const requestsLabel = `${primary.requestCount.toLocaleString("en-US")} request${
    primary.requestCount === 1 ? "" : "s"
  }`;
  const usageLine =
    hasAllowance && allowanceMicros
      ? `${requestsLabel} · ${formatUsdMicrosSummary(primary.usedUsdMicros)} of ${formatUsdMicrosSummary(allowanceMicros)} allowance used`
      : `${requestsLabel} · ${formatUsdMicrosSummary(primary.usedUsdMicros)} this cycle`;
  const pressure = resolveOwnerBillingPressure({
    hasPaymentMethod: Boolean(defaultPaymentMethod),
    creditBalanceUsdMicros,
    subscriptions,
  });
  const needsPaymentMethod = pressure === "blocked";
  const billingLinkLabel = needsPaymentMethod
    ? "Attach payment method →"
    : "View Billing →";

  return (
    <div
      className={`rounded-lg border px-3 py-3 ${
        needsPaymentMethod
          ? "border-amber-500/30 bg-amber-500/10"
          : "border-white/[0.05] bg-black/20"
      }`}
    >
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
          {needsPaymentMethod ? (
            <p className="mt-1 text-xs text-amber-200/90">
              Starter allowance used up — usage is paused until you attach a payment
              method.
            </p>
          ) : null}
        </div>
        <Link
          href="/billing"
          className={`shrink-0 text-sm font-medium transition-colors ${
            needsPaymentMethod
              ? "text-amber-300 hover:text-amber-200"
              : "text-emerald-400 hover:text-emerald-300"
          }`}
        >
          {billingLinkLabel}
        </Link>
      </div>
      {hasAllowance && allowanceMicros ? (
        <AllowanceProgressBar
          usedUsdMicros={primary.usedUsdMicros}
          allowanceUsdMicros={allowanceMicros}
          className="mt-3"
        />
      ) : null}

      <CostWaterfall
        className="mt-4"
        usedUsdMicros={primary.usedUsdMicros}
        planIncludedUsdMicros={primary.discountUsdMicros}
        creditBalanceUsdMicros={creditBalanceUsdMicros}
        paymentMethod={defaultPaymentMethod}
        needsPaymentMethod={needsPaymentMethod}
      />
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
  historyIdentityIds,
  onClearIdentityFilter,
}: Readonly<{
  needsSelection: boolean;
  scope: "all" | "single";
  /** Own/administered apps vs platform-wide admin history. */
  historyScope: "own" | "all";
  orderedApps: BillingAppRow[];
  historyClientIds: string[];
  /** Identity filter from the Identities dropdown; empty means all. */
  historyIdentityIds: string[];
  onClearIdentityFilter: () => void;
}>) {
  if (needsSelection) {
    return (
      <section className="mb-6 sm:mb-8 rounded-xl border border-zinc-800 bg-zinc-900/30 p-4 sm:p-5">
        <h2 className="text-sm font-semibold text-zinc-200">Requests</h2>
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
        externalUserIds={historyIdentityIds}
        onClearIdentityFilter={onClearIdentityFilter}
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

function identityFilterOptions(
  appUsage: BillingUsageDashboardClientPayload["appUsage"],
): { value: string; label: string }[] {
  const feeByIdentity = new Map<string, bigint>();
  for (const entry of appUsage) {
    for (const user of entry.byUser) {
      const id = user.externalUserId;
      if (!id) continue;
      feeByIdentity.set(
        id,
        (feeByIdentity.get(id) ?? 0n) + BigInt(user.networkFeeUsdMicros || "0"),
      );
    }
  }
  return [...feeByIdentity.entries()]
    .sort((a, b) => {
      if (a[1] === b[1]) return a[0].localeCompare(b[0]);
      return b[1] > a[1] ? 1 : -1;
    })
    .map(([id]) => ({ value: id, label: id }));
}

function BillingPeriodPanel({
  data,
  showTabs,
  activeTab,
  isMultiApp,
  filterOptions,
  identityOptions,
  selectedAppIds,
  setSelectedAppIds,
  selectedIdentityIds,
  setSelectedIdentityIds,
  chartDimension,
  setChartDimension,
  filteredSeries,
}: Readonly<{
  data: BillingUsageDashboardClientPayload;
  showTabs: boolean;
  activeTab: UsageTab;
  isMultiApp: boolean;
  filterOptions: { value: string; label: string }[];
  identityOptions: { value: string; label: string }[];
  selectedAppIds: string[];
  setSelectedAppIds: (ids: string[]) => void;
  selectedIdentityIds: string[];
  setSelectedIdentityIds: (ids: string[]) => void;
  chartDimension: ChartDimension;
  setChartDimension: (dimension: ChartDimension) => void;
  filteredSeries: BillingChartSeries[];
}>) {
  const periodCopy =
    activeTab === "all" && showTabs
      ? "Platform-wide usage for the current cycle."
      : "Usage for apps you own or administer.";
  const showMineSubscriptions = activeTab === "mine" || !showTabs;

  return (
    <div className="mb-6 sm:mb-8 rounded-xl border border-white/[0.06] bg-white/[0.02] backdrop-blur-sm p-5">
      <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h3 className="font-semibold text-zinc-100">This billing period</h3>
          <p className="text-xs text-zinc-500 mt-1">{periodCopy}</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {isMultiApp && filterOptions.length > 0 ? (
            <AppFilterDropdown
              options={filterOptions}
              selectedValues={selectedAppIds}
              onChange={setSelectedAppIds}
            />
          ) : null}
          {identityOptions.length > 0 ? (
            <AppFilterDropdown
              options={identityOptions}
              selectedValues={selectedIdentityIds}
              onChange={setSelectedIdentityIds}
              label="Identities"
              emptyLabel="No identities"
              allLabel="All identities"
            />
          ) : null}
        </div>
      </div>

      {showMineSubscriptions ? (
        <div className="mb-5">
          <ActiveSubscriptionSummary
            subscriptions={data.activeSubscriptions ?? []}
            creditBalanceUsdMicros={data.creditBalanceUsdMicros ?? null}
            defaultPaymentMethod={data.defaultPaymentMethod ?? null}
          />
        </div>
      ) : null}

      <div>
        <div className="mb-1 flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
          <h4 className="text-sm font-medium text-zinc-200">
            Usage over billing period
          </h4>
          <div className="inline-flex self-start rounded-lg border border-zinc-700 p-0.5">
            {(
              [
                { key: "pipeline", label: "Pipeline" },
                { key: "identity", label: "Identity" },
              ] as const
            ).map((option) => (
              <button
                key={option.key}
                type="button"
                onClick={() => setChartDimension(option.key)}
                aria-pressed={chartDimension === option.key}
                className={`rounded-md px-3 py-1 text-xs font-semibold transition-colors ${
                  chartDimension === option.key
                    ? "bg-zinc-700 text-zinc-100"
                    : "text-zinc-400 hover:text-zinc-200"
                }`}
              >
                {option.label}
              </button>
            ))}
          </div>
        </div>
        <p className="text-xs text-zinc-500 mb-4">
          {chartDimension === "identity"
            ? "Each bar segment is one app × identity."
            : "Each bar segment is one app × pipeline/model."}
        </p>
        {filteredSeries.length === 0 ? (
          <p className="text-sm text-zinc-500">
            {chartEmptyMessage(selectedAppIds.length)}
          </p>
        ) : (
          <UsageBreakdownChart
            series={filteredSeries}
            valueLabel="Usage"
            height={220}
            maxSeries={12}
          />
        )}
      </div>
    </div>
  );
}

function BillingUsageBody({
  data,
  showTabs,
  activeTab,
}: Readonly<{
  data: BillingUsageDashboardClientPayload;
  showTabs: boolean;
  activeTab: UsageTab;
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

  // Identities that transacted this cycle, most expensive first (matches the
  // Identities table default so the two surfaces agree).
  const identityOptions = useMemo(
    () => identityFilterOptions(data.appUsage),
    [data.appUsage],
  );

  const allIdentityIds = useMemo(
    () => identityOptions.map((o) => o.value),
    [identityOptions],
  );
  const allIdentityKey = allIdentityIds.join("\0");

  const [selectedAppIds, setSelectedAppIds] = useState<string[]>(() =>
    allPublicClientIds,
  );
  const [prevAllIdsKey, setPrevAllIdsKey] = useState(allIdsKey);
  const [selectedIdentityIds, setSelectedIdentityIds] =
    useState<string[]>(allIdentityIds);
  const [prevIdentityKey, setPrevIdentityKey] = useState(allIdentityKey);
  const [chartDimension, setChartDimension] = useState<ChartDimension>("pipeline");

  // Reset selection when the loaded app set changes (tab switch / reload).
  // Adjust during render — avoids setState-in-effect cascading renders.
  if (prevAllIdsKey !== allIdsKey) {
    setPrevAllIdsKey(allIdsKey);
    setSelectedAppIds(allIdsKey.length > 0 ? allIdsKey.split("\0") : []);
  }
  if (prevIdentityKey !== allIdentityKey) {
    setPrevIdentityKey(allIdentityKey);
    setSelectedIdentityIds(allIdentityKey.length > 0 ? allIdentityKey.split("\0") : []);
  }

  const historyScope: "own" | "all" =
    showTabs && activeTab === "all" ? "all" : "own";
  const derived = deriveFilteredView(
    data,
    selectedAppIds,
    historyScope,
    chartDimension,
    selectedIdentityIds,
    allIdentityIds,
  );

  return (
    <>
      <div className="mb-6 sm:mb-8 flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <BillingDashboardHeader
          scope={scope}
          singleAppName={singleAppName}
          cycle={cycle}
          isOpenMeter={isOpenMeter}
          appId={scope === "single" ? orderedApps[0]?.id : null}
        />
        {showTabs ? (
          <div className="flex shrink-0 items-center gap-1 self-start rounded-lg bg-black/20 p-0.5">
            <TabLink active={activeTab === "mine"} href="/usage">
              My Usage
            </TabLink>
            <TabLink active={activeTab === "all"} href="/usage/all">
              All Usage
            </TabLink>
          </div>
        ) : null}
      </div>

      <BillingPeriodPanel
        data={data}
        showTabs={showTabs}
        activeTab={activeTab}
        isMultiApp={isMultiApp}
        filterOptions={filterOptions}
        identityOptions={identityOptions}
        selectedAppIds={selectedAppIds}
        setSelectedAppIds={setSelectedAppIds}
        selectedIdentityIds={selectedIdentityIds}
        setSelectedIdentityIds={setSelectedIdentityIds}
        chartDimension={chartDimension}
        setChartDimension={setChartDimension}
        filteredSeries={derived.filteredSeries}
      />

      <SignedTicketsBlock
        needsSelection={selectedAppIds.length === 0 && isMultiApp}
        scope={scope}
        historyScope={historyScope}
        orderedApps={orderedApps}
        historyClientIds={derived.historyClientIds}
        historyIdentityIds={derived.historyIdentityIds}
        onClearIdentityFilter={() => setSelectedIdentityIds(allIdentityIds)}
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
 * All Usage lives at `/usage/all` so refresh keeps the platform-wide view.
 */
export default function BillingUsageDashboard({
  filterAppId,
  fundPanel,
  wrapLayout = true,
}: Readonly<{
  filterAppId?: string | null;
  /** Optional MoonPay / prepaid top-up panel (app owners on pay-per-use). */
  fundPanel?: ReactNode;
  /** When false, the parent route already provides DashboardLayout. */
  wrapLayout?: boolean;
}>) {
  const { data: session, status: authStatus } = useSession();
  const pathname = usePathname();
  const router = useRouter();
  const role = (session?.user as Record<string, unknown> | undefined)?.role as
    | string
    | undefined;
  const isAdmin = role === "admin";
  const showTabs = isAdmin && !filterAppId;
  const wantsAllUsage = !filterAppId && pathname.startsWith("/usage/all");
  const activeTab: UsageTab = showTabs && wantsAllUsage ? "all" : "mine";

  const [state, setState] = useState<LoadState>({ status: "loading" });
  const [retryToken, setRetryToken] = useState(0);

  // /usage/all is admin-only; bounce everyone else to /usage.
  useEffect(() => {
    if (!wantsAllUsage) return;
    if (authStatus === "loading") return;
    if (authStatus === "unauthenticated" || !isAdmin) {
      router.replace("/usage");
    }
  }, [wantsAllUsage, authStatus, isAdmin, router]);

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

  const body = (
    <>
      {fundPanel}
      {state.status === "loading" ? (
        <>
          {showTabs ? (
            <div className="mb-4 flex justify-end">
              <div className="flex shrink-0 items-center gap-1 rounded-lg bg-black/20 p-0.5">
                <TabLink active={activeTab === "mine"} href="/usage">
                  My Usage
                </TabLink>
                <TabLink active={activeTab === "all"} href="/usage/all">
                  All Usage
                </TabLink>
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
        />
      ) : null}
    </>
  );

  if (!wrapLayout) {
    return body;
  }

  return <DashboardLayout>{body}</DashboardLayout>;
}
