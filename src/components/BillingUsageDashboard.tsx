import { notFound } from "next/navigation";
import DashboardLayout from "@/components/DashboardLayout";
import UsageLineChart from "@/components/UsageLineChart";
import {
  AppUsageSection,
  BillingDashboardHeader,
} from "@/components/BillingUsageDashboard.helpers";
import { formatBillingWei } from "@/lib/billing-format";
import { getBillingUsageDashboardData } from "@/lib/billing-usage-dashboard-data";
import { formatUsdMicros } from "@/lib/format-usd";

export default async function BillingUsageDashboard({
  filterAppId,
}: {
  filterAppId?: string | null;
}) {
  const result = await getBillingUsageDashboardData(filterAppId ?? undefined);

  if (!result.ok) {
    if (result.reason === "no_session") {
      return (
        <DashboardLayout>
          <div className="text-center py-12">
            <h2 className="text-lg font-medium text-zinc-300">Billing unavailable</h2>
            <p className="text-zinc-500 mt-2">Please sign in to view billing and usage.</p>
          </div>
        </DashboardLayout>
      );
    }
    notFound();
  }

  const {
    scope,
    userId,
    role,
    isAdmin,
    usageSource,
    cycle,
    orderedApps,
    appUsage,
    chartData,
    totalRequests,
    totalFeeWei,
    totalNetworkFeeUsdMicros,
    appsWithUsage,
  } = result.data;

  const isOpenMeter = usageSource === "openmeter";
  const totalFeesLabel = isOpenMeter
    ? formatUsdMicros(totalNetworkFeeUsdMicros.toString(), 6) ?? "$0"
    : formatBillingWei(totalFeeWei.toString());

  const singleAppName = scope === "single" ? orderedApps[0]?.name : null;
  let viewerRoleDetail = "owner applications only";
  if (scope === "single") {
    viewerRoleDetail = "single application";
  } else if (isAdmin) {
    viewerRoleDetail = "all applications visible";
  }

  return (
    <DashboardLayout>
      <div className="mb-6 sm:mb-8">
        <BillingDashboardHeader
          scope={scope}
          singleAppName={singleAppName}
          cycle={cycle}
          isOpenMeter={isOpenMeter}
        />
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4 mb-6 sm:mb-8">
        <div className="border border-zinc-800 rounded-xl p-4 sm:p-5 bg-zinc-900/30 min-w-0">
          <p className="text-xs text-zinc-500 uppercase tracking-wider mb-2">Applications</p>
          <p className="text-lg sm:text-xl font-bold text-zinc-100 tabular-nums">
            {orderedApps.length}
          </p>
          <p className="text-xs text-zinc-600 mt-1">{appsWithUsage} with usage this cycle</p>
        </div>
        <div className="border border-zinc-800 rounded-xl p-4 sm:p-5 bg-zinc-900/30 min-w-0">
          <p className="text-xs text-zinc-500 uppercase tracking-wider mb-2">Requests</p>
          <p className="text-lg sm:text-xl font-bold text-zinc-100 tabular-nums">{totalRequests}</p>
          <p className="text-xs text-zinc-600 mt-1">runtime requests this cycle</p>
        </div>
        <div className="border border-zinc-800 rounded-xl p-4 sm:p-5 bg-zinc-900/30 min-w-0">
          <p className="text-xs text-zinc-500 uppercase tracking-wider mb-2">Total Fees</p>
          <p
            className={`font-mono text-lg sm:text-xl font-bold break-all leading-snug ${
              isOpenMeter ? "text-emerald-400" : "text-zinc-100"
            }`}
            title={totalFeesLabel}
          >
            {totalFeesLabel}
          </p>
          <p className="text-xs text-zinc-600 mt-2">
            {isOpenMeter ? "network fees (OpenMeter)" : "estimated usage fees"}
          </p>
        </div>
        <div className="border border-zinc-800 rounded-xl p-4 sm:p-5 bg-zinc-900/30 min-w-0">
          <p className="text-xs text-zinc-500 uppercase tracking-wider mb-2">Viewer Role</p>
          <p className="text-lg sm:text-xl font-bold text-zinc-100 capitalize truncate">
            {role || "developer"}
          </p>
          <p className="text-xs text-zinc-600 mt-1">{viewerRoleDetail}</p>
        </div>
      </div>

      <div className="mb-6 sm:mb-8 rounded-xl border border-zinc-800 bg-zinc-900/30 p-4 sm:p-5">
        <h2 className="text-sm font-semibold text-zinc-200 mb-4">Usage over billing period</h2>
        <UsageLineChart data={chartData} valueLabel="Requests / day" />
      </div>

      {appUsage.length === 0 ? (
        <div className="rounded-xl border border-zinc-800 bg-zinc-900/30 p-6 text-center">
          <p className="text-zinc-300 font-medium">No applications available</p>
          <p className="text-zinc-500 text-sm mt-1">
            {isAdmin
              ? "No developer applications exist yet."
              : "Create your first app to start tracking billing and usage."}
          </p>
        </div>
      ) : (
        <div className="space-y-6">
          {appUsage.map((entry) => (
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
      )}
    </DashboardLayout>
  );
}
