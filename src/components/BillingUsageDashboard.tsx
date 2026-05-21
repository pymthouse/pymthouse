import Link from "next/link";
import { notFound } from "next/navigation";
import DashboardLayout from "@/components/DashboardLayout";
import UsageLineChart from "@/components/UsageLineChart";
import {
  formatBillingPeriod,
  formatBillingWei,
  getBillingUsageDashboardData,
} from "@/platform/ops/billing-usage-dashboard-data";
import { formatUsdMicrosString } from "@/shared/utils/format-usd-micros";

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
    cycle,
    orderedApps,
    appUsage,
    chartData,
    totalRequests,
    totalFeeWei,
    appsWithUsage,
  } = result.data;

  const singleAppName = scope === "single" ? orderedApps[0]?.name : null;

  return (
    <DashboardLayout>
      <div className="mb-6 sm:mb-8">
        {scope === "single" ? (
          <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between sm:gap-4">
            <div>
              <h1 className="text-xl sm:text-2xl font-bold text-zinc-100">
                Usage
                {singleAppName ? (
                  <span className="text-zinc-400 font-normal"> · {singleAppName}</span>
                ) : null}
              </h1>
              <p className="text-xs sm:text-sm text-zinc-500 mt-1">
                Usage and per-identity breakdown for this application in the current billing cycle.
              </p>
              <p className="text-xs text-zinc-600 mt-2 break-words">
                Cycle: {formatBillingPeriod(cycle.start)} — {formatBillingPeriod(cycle.end)}
              </p>
            </div>
            <Link
              href="/billing"
              className="shrink-0 text-sm text-emerald-400 hover:text-emerald-300 transition-colors"
            >
              ← All applications
            </Link>
          </div>
        ) : (
          <>
            <h1 className="text-xl sm:text-2xl font-bold text-zinc-100">Usage</h1>
            <p className="text-xs sm:text-sm text-zinc-500 mt-1">
              Applications are ordered by requests this billing cycle; apps owned by Test User appear
              after all others, with per-user billing breakdowns.
            </p>
            <p className="text-xs text-zinc-600 mt-2 break-words">
              Cycle: {formatBillingPeriod(cycle.start)} — {formatBillingPeriod(cycle.end)}
            </p>
          </>
        )}
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
            className="font-mono text-lg sm:text-xl font-bold text-zinc-100 break-all leading-snug"
            title={formatBillingWei(totalFeeWei.toString())}
          >
            {formatBillingWei(totalFeeWei.toString())}
          </p>
          <p className="text-xs text-zinc-600 mt-2">estimated usage fees</p>
        </div>
        <div className="border border-zinc-800 rounded-xl p-4 sm:p-5 bg-zinc-900/30 min-w-0">
          <p className="text-xs text-zinc-500 uppercase tracking-wider mb-2">Viewer Role</p>
          <p className="text-lg sm:text-xl font-bold text-zinc-100 capitalize truncate">
            {role || "developer"}
          </p>
          <p className="text-xs text-zinc-600 mt-1">
            {scope === "single"
              ? "single application"
              : isAdmin
                ? "all applications visible"
                : "owner applications only"}
          </p>
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
            <section
              key={entry.app.id}
              className="rounded-xl border border-zinc-800 bg-zinc-900/30 overflow-hidden"
            >
              <div className="px-4 py-4 sm:px-5 border-b border-zinc-800">
                <div className="flex flex-col gap-4 sm:flex-row sm:flex-wrap sm:items-start sm:justify-between sm:gap-3">
                  <div className="min-w-0">
                    {scope === "all" ? (
                      <h2 className="font-semibold text-zinc-100 break-words">
                        <Link
                          href={`/apps/${entry.app.id}/usage`}
                          className="hover:text-emerald-400 transition-colors"
                        >
                          {entry.app.name}
                        </Link>
                      </h2>
                    ) : (
                      <h2 className="font-semibold text-zinc-100 break-words">{entry.app.name}</h2>
                    )}
                    <p className="text-xs text-zinc-500 mt-1 font-mono break-all">{entry.app.id}</p>
                    {isAdmin && (
                      <p className="text-xs text-zinc-500 mt-1 break-words">
                        Owner:{" "}
                        <span className="text-zinc-300">
                          {entry.app.ownerName || entry.app.ownerEmail || entry.app.ownerId}
                        </span>
                        {entry.app.ownerId === userId ? " (you)" : ""}
                      </p>
                    )}
                  </div>
                  <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 sm:gap-3 text-right shrink-0 w-full min-w-0 sm:w-auto sm:max-w-full">
                    <div className="min-w-0">
                      <p className="text-[11px] uppercase tracking-wider text-zinc-500">Requests</p>
                      <p className="text-sm font-semibold text-zinc-200 tabular-nums">
                        {entry.requestCount}
                      </p>
                    </div>
                    <div className="min-w-0">
                      <p className="text-[11px] uppercase tracking-wider text-zinc-500">Network fee (ETH)</p>
                      <p className="text-sm font-semibold text-zinc-200 font-mono break-all">
                        {formatBillingWei(entry.totalFeeWei)}
                      </p>
                    </div>
                    <div className="min-w-0">
                      <p className="text-[11px] uppercase tracking-wider text-zinc-500">Network fee (USD)</p>
                      <p className="text-sm font-semibold text-emerald-400 font-mono break-all">
                        {formatUsdMicrosString(entry.networkFeeUsdMicros, 4) ?? "—"}
                      </p>
                    </div>
                    <div className="min-w-0">
                      <p className="text-[11px] uppercase tracking-wider text-zinc-500">Billable (USD)</p>
                      <p className="text-sm font-semibold text-zinc-200 font-mono break-all">
                        {formatUsdMicrosString(entry.endUserBillableUsdMicros, 4) ?? "—"}
                      </p>
                    </div>
                  </div>
                  {entry.byPipelineModel.length > 0 && (
                    <div className="flex flex-wrap gap-2 mt-2">
                      {entry.byPipelineModel.map((pm) => (
                        <span
                          key={`${pm.pipeline}|${pm.modelId}`}
                          className="text-xs bg-zinc-800 text-zinc-300 px-2 py-0.5 rounded"
                          title={`${pm.requestCount} requests · ${formatUsdMicrosString(pm.networkFeeUsdMicros, 6) ?? "—"}`}
                        >
                          {pm.pipeline} / {pm.modelId.length > 20 ? `${pm.modelId.slice(0, 18)}…` : pm.modelId}
                        </span>
                      ))}
                    </div>
                  )}
                </div>
              </div>

              {entry.byUser.length > 0 ? (
                <div className="overflow-x-auto -mx-4 px-4 sm:mx-0 sm:px-0">
                  <table className="w-full text-sm min-w-[32rem]">
                    <thead>
                      <tr className="border-b border-zinc-800 text-zinc-500 text-xs uppercase tracking-wider">
                        <th className="text-left px-4 sm:px-5 py-3 font-medium">Identity</th>
                        <th className="text-left px-4 sm:px-5 py-3 font-medium">Identifier</th>
                        <th className="text-right px-4 sm:px-5 py-3 font-medium">Requests</th>
                        <th className="text-right px-4 sm:px-5 py-3 font-medium">Units</th>
                        <th className="text-right px-4 sm:px-5 py-3 font-medium">Total Fees</th>
                      </tr>
                    </thead>
                    <tbody>
                      {entry.byUser.map((userUsage) => (
                        <tr
                          key={`${entry.app.id}:${userUsage.endUserId}`}
                          className="border-b border-zinc-800/50 hover:bg-zinc-800/20"
                        >
                          <td className="px-4 sm:px-5 py-3">
                            <div className="flex flex-wrap items-center gap-2">
                              <code className="text-xs text-zinc-300">
                                {userUsage.userLabel}
                              </code>
                              <span
                                className={`px-1.5 py-0.5 rounded text-[10px] uppercase tracking-wider ${
                                  userUsage.userType === "system_managed"
                                    ? "bg-cyan-500/20 text-cyan-300"
                                    : userUsage.userType === "oidc_authorized"
                                      ? "bg-amber-500/20 text-amber-300"
                                      : "bg-zinc-700/40 text-zinc-400"
                                }`}
                              >
                                {userUsage.userType === "system_managed"
                                  ? "system"
                                  : userUsage.userType === "oidc_authorized"
                                    ? "oidc"
                                    : "unknown"}
                              </span>
                            </div>
                          </td>
                          <td className="px-4 sm:px-5 py-3">
                            <code className="text-xs text-zinc-500" title={userUsage.identifier}>
                              {userUsage.identifier === "unknown"
                                ? "unknown"
                                : userUsage.identifier.length > 8
                                  ? `${userUsage.identifier.slice(0, 8)}...`
                                  : userUsage.identifier}
                            </code>
                          </td>
                          <td className="px-4 sm:px-5 py-3 text-right text-zinc-300 tabular-nums">
                            {userUsage.requestCount}
                          </td>
                          <td className="px-4 sm:px-5 py-3 text-right text-zinc-300 font-mono text-xs break-all">
                            {userUsage.totalUnits}
                          </td>
                          <td className="px-4 sm:px-5 py-3 text-right text-zinc-300 font-mono text-xs break-all">
                            {formatBillingWei(userUsage.totalFeeWei)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                <div className="p-5 text-center">
                  <p className="text-sm text-zinc-500">
                    No usage for this application in the current cycle yet.
                  </p>
                </div>
              )}
            </section>
          ))}
        </div>
      )}
    </DashboardLayout>
  );
}
