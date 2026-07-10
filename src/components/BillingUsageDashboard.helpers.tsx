import Link from "next/link";
import { formatBillingPeriod, formatBillingWei } from "@/lib/billing-format";
import type {
  BillingAppUsageSummary,
  BillingUsageDashboardPayload,
  BillingUserUsageRow,
} from "@/lib/billing-usage-dashboard-data";
import { formatUsdMicros } from "@/lib/format-usd";

type AppUsageEntry = BillingAppUsageSummary;
type UserUsage = BillingUserUsageRow;

export function userTypeBadgeClass(userType: UserUsage["userType"]): string {
  if (userType === "system_managed") {
    return "bg-cyan-500/20 text-cyan-300";
  }
  if (userType === "oidc_authorized") {
    return "bg-amber-500/20 text-amber-300";
  }
  return "bg-zinc-700/40 text-zinc-400";
}

export function userTypeLabel(userType: UserUsage["userType"]): string {
  if (userType === "system_managed") {
    return "system";
  }
  if (userType === "oidc_authorized") {
    return "oidc";
  }
  return "unknown";
}

export function formatIdentifierDisplay(identifier: string): string {
  if (identifier === "unknown") {
    return "unknown";
  }
  if (identifier.length > 8) {
    return `${identifier.slice(0, 8)}...`;
  }
  return identifier;
}

export function BillingDashboardHeader({
  scope,
  singleAppName,
  cycle,
  isOpenMeter,
}: Readonly<{
  scope: BillingUsageDashboardPayload["scope"];
  singleAppName: string | null | undefined;
  cycle: BillingUsageDashboardPayload["cycle"];
  isOpenMeter: boolean;
}>) {
  const sourceClass = isOpenMeter ? "text-emerald-500/90" : "text-zinc-500";
  const sourceLabel = isOpenMeter ? "OpenMeter" : "Postgres";
  const cycleLine = (
    <p className="text-xs text-zinc-600 mt-2 break-words">
      Cycle: {formatBillingPeriod(cycle.start)} — {formatBillingPeriod(cycle.end)}
      <span className="mx-2 text-zinc-700">·</span>
      <span className={sourceClass}>Source: {sourceLabel}</span>
    </p>
  );

  if (scope === "single") {
    return (
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
          {cycleLine}
        </div>
        <Link
          href="/billing"
          className="shrink-0 text-sm text-emerald-400 hover:text-emerald-300 transition-colors"
        >
          ← All applications
        </Link>
      </div>
    );
  }

  return (
    <>
      <h1 className="text-xl sm:text-2xl font-bold text-zinc-100">Usage</h1>
      <p className="text-xs sm:text-sm text-zinc-500 mt-1">
        Applications are ordered by requests this billing cycle; apps owned by Test User appear
        after all others, with per-user billing breakdowns.
      </p>
      {cycleLine}
    </>
  );
}

export function AppUsageSection({
  entry,
  scope,
  isAdmin,
  isOpenMeter,
  userId,
}: Readonly<{
  entry: AppUsageEntry;
  scope: BillingUsageDashboardPayload["scope"];
  isAdmin: boolean;
  isOpenMeter: boolean;
  userId: string;
}>) {
  return (
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
              <p className="text-[11px] uppercase tracking-wider text-zinc-500">
                {isOpenMeter ? "Network fee (USD)" : "Network fee (ETH)"}
              </p>
              <p
                className={`text-sm font-semibold font-mono break-all ${
                  isOpenMeter ? "text-emerald-400" : "text-zinc-200"
                }`}
              >
                {isOpenMeter
                  ? formatUsdMicros(entry.networkFeeUsdMicros, 6) ?? "—"
                  : formatBillingWei(entry.totalFeeWei)}
              </p>
            </div>
            <div className="min-w-0">
              <p className="text-[11px] uppercase tracking-wider text-zinc-500">
                {isOpenMeter ? "Billable (USD est.)" : "Network fee (USD)"}
              </p>
              <p className="text-sm font-semibold text-zinc-200 font-mono break-all">
                {formatUsdMicros(
                  isOpenMeter ? entry.endUserBillableUsdMicros : entry.networkFeeUsdMicros,
                  6,
                ) ?? "—"}
              </p>
            </div>
          </div>
          {entry.byPipelineModel.length > 0 && (
            <div className="flex flex-wrap gap-2 mt-2">
              {entry.byPipelineModel.map((pm) => (
                <span
                  key={`${pm.pipeline}|${pm.modelId}`}
                  className="text-xs bg-zinc-800 text-zinc-300 px-2 py-0.5 rounded"
                  title={`${pm.requestCount} requests · ${formatUsdMicros(pm.networkFeeUsdMicros, 6) ?? "—"}`}
                >
                  {pm.pipeline} / {pm.modelId.length > 20 ? `${pm.modelId.slice(0, 18)}…` : pm.modelId}
                </span>
              ))}
            </div>
          )}
        </div>
      </div>

      {entry.byUser.length > 0 ? (
        <AppUsageUserTable entry={entry} isOpenMeter={isOpenMeter} />
      ) : (
        <div className="p-5 text-center">
          <p className="text-sm text-zinc-500">
            No usage for this application in the current cycle yet.
          </p>
        </div>
      )}
    </section>
  );
}

function formatPipelineModelLabel(pipeline: string, modelId: string): string {
  const model =
    modelId.length > 24 ? `${modelId.slice(0, 22)}…` : modelId;
  return `${pipeline} / ${model}`;
}

function AppUsageUserTable({
  entry,
  isOpenMeter,
}: Readonly<{
  entry: AppUsageEntry;
  isOpenMeter: boolean;
}>) {
  return (
    <div className="overflow-x-auto -mx-4 px-4 sm:mx-0 sm:px-0">
      <table className="w-full text-sm min-w-[32rem]">
        <thead>
          <tr className="border-b border-zinc-800 text-zinc-500 text-xs uppercase tracking-wider">
            <th className="text-left px-4 sm:px-5 py-3 font-medium">Identity</th>
            <th className="text-left px-4 sm:px-5 py-3 font-medium">Identifier</th>
            <th className="text-right px-4 sm:px-5 py-3 font-medium">Requests</th>
            {!isOpenMeter && (
              <>
                <th className="text-right px-4 sm:px-5 py-3 font-medium">Units</th>
                <th className="text-right px-4 sm:px-5 py-3 font-medium">Total Fees</th>
              </>
            )}
            {isOpenMeter && (
              <th className="text-right px-4 sm:px-5 py-3 font-medium">Network fee (USD)</th>
            )}
          </tr>
        </thead>
        <tbody>
          {entry.byUser.flatMap((userUsage) => {
            const userRow = (
              <tr
                key={`${entry.app.id}:${userUsage.endUserId}`}
                className="border-b border-zinc-800/50 hover:bg-zinc-800/20"
              >
                <td className="px-4 sm:px-5 py-3">
                  <div className="flex flex-wrap items-center gap-2">
                    <code className="text-xs text-zinc-300">{userUsage.userLabel}</code>
                    <span
                      className={`px-1.5 py-0.5 rounded text-[10px] uppercase tracking-wider ${userTypeBadgeClass(userUsage.userType)}`}
                    >
                      {userTypeLabel(userUsage.userType)}
                    </span>
                  </div>
                </td>
                <td className="px-4 sm:px-5 py-3">
                  <code className="text-xs text-zinc-500" title={userUsage.identifier}>
                    {formatIdentifierDisplay(userUsage.identifier)}
                  </code>
                </td>
                <td className="px-4 sm:px-5 py-3 text-right text-zinc-300 tabular-nums">
                  {userUsage.requestCount}
                </td>
                {!isOpenMeter && (
                  <>
                    <td className="px-4 sm:px-5 py-3 text-right text-zinc-300 font-mono text-xs break-all">
                      {userUsage.totalUnits}
                    </td>
                    <td className="px-4 sm:px-5 py-3 text-right text-zinc-300 font-mono text-xs break-all">
                      {formatBillingWei(userUsage.totalFeeWei)}
                    </td>
                  </>
                )}
                {isOpenMeter && (
                  <td className="px-4 sm:px-5 py-3 text-right text-emerald-400 font-mono text-xs font-semibold break-all">
                    {formatUsdMicros(userUsage.networkFeeUsdMicros, 6) ?? "—"}
                  </td>
                )}
              </tr>
            );

            const breakdownRows = userUsage.byPipelineModel.map((pm) => (
              <tr
                key={`${entry.app.id}:${userUsage.endUserId}:${pm.pipeline}|${pm.modelId}`}
                className="border-b border-zinc-800/30 bg-zinc-950/30 hover:bg-zinc-800/10"
              >
                <td className="px-4 sm:px-5 py-2 pl-8 sm:pl-10" colSpan={2}>
                  <span className="text-xs text-zinc-500">
                    {formatPipelineModelLabel(pm.pipeline, pm.modelId)}
                  </span>
                </td>
                <td className="px-4 sm:px-5 py-2 text-right text-zinc-400 tabular-nums text-xs">
                  {pm.requestCount}
                </td>
                {!isOpenMeter && (
                  <>
                    <td className="px-4 sm:px-5 py-2 text-right text-zinc-500 font-mono text-xs">
                      —
                    </td>
                    <td className="px-4 sm:px-5 py-2 text-right text-zinc-500 font-mono text-xs">
                      —
                    </td>
                  </>
                )}
                {isOpenMeter && (
                  <td className="px-4 sm:px-5 py-2 text-right text-zinc-400 tabular-nums text-xs break-all">
                    {formatUsdMicros(pm.networkFeeUsdMicros, 6) ?? "—"}
                  </td>
                )}
              </tr>
            ));

            return breakdownRows.length > 0 ? [userRow, ...breakdownRows] : [userRow];
          })}
        </tbody>
      </table>
    </div>
  );
}
