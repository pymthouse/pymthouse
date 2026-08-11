"use client";

import Link from "next/link";
import { useMemo, useState } from "react";

import { formatBillableDuration, formatBillingUtcDate } from "@/lib/billing-format";
import { formatUsdMicrosString } from "@/lib/format-usd-micros";
import type { AppIdentityRow } from "@/lib/usage/identity-rollup";

type SortKey = "fee" | "requests" | "duration" | "lastActive";

/** Fee descending — the "who burned my allowance" question the table exists to answer. */
const DEFAULT_SORT: SortKey = "fee";

function compareBigIntDesc(a: string, b: string): number {
  try {
    const left = BigInt(a || "0");
    const right = BigInt(b || "0");
    if (left === right) return 0;
    return right > left ? 1 : -1;
  } catch {
    return 0;
  }
}

function sortIdentities(rows: AppIdentityRow[], key: SortKey): AppIdentityRow[] {
  const sorted = [...rows];
  if (key === "requests") {
    sorted.sort((a, b) => b.requestCount - a.requestCount);
  } else if (key === "duration") {
    sorted.sort((a, b) => Number(b.billableSecs || 0) - Number(a.billableSecs || 0));
  } else if (key === "lastActive") {
    sorted.sort((a, b) => (b.lastActiveDate ?? "").localeCompare(a.lastActiveDate ?? ""));
  } else {
    sorted.sort((a, b) => compareBigIntDesc(a.networkFeeUsdMicros, b.networkFeeUsdMicros));
  }
  return sorted;
}

function statusBadgeClass(status: string): string {
  if (status === "active") return "bg-emerald-500/15 text-emerald-400";
  if (status === "inactive") return "bg-amber-500/15 text-amber-300";
  if (status === "suspended" || status === "revoked") return "bg-red-500/15 text-red-400";
  if (status === "unprovisioned") return "bg-zinc-700/40 text-zinc-400";
  return "bg-zinc-700/40 text-zinc-400";
}

function statusLabel(row: AppIdentityRow): string {
  return row.provisioned ? row.status : "unprovisioned";
}

/** Render a UTC date key with a fixed locale so SSR and client hydrate alike. */
function formatLastActive(dateKey: string | null): string {
  if (!dateKey) return "Never";
  const iso = `${dateKey}T00:00:00Z`;
  if (Number.isNaN(Date.parse(iso))) return "Never";
  return formatBillingUtcDate(iso);
}

function SortHeader({
  label,
  sortKey,
  activeKey,
  onSort,
}: Readonly<{
  label: string;
  sortKey: SortKey;
  activeKey: SortKey;
  onSort: (key: SortKey) => void;
}>) {
  const active = activeKey === sortKey;
  return (
    <th
      className="text-right px-4 sm:px-5 py-3 font-medium"
      aria-sort={active ? "descending" : "none"}
    >
      <button
        type="button"
        onClick={() => onSort(sortKey)}
        className={`inline-flex items-center gap-1 transition-colors ${
          active ? "text-zinc-200" : "hover:text-zinc-300"
        }`}
      >
        {label}
        <span aria-hidden className={active ? "text-emerald-400" : "text-transparent"}>
          ↓
        </span>
      </button>
    </th>
  );
}

function IdentityApiKeyCell({
  row,
  appId,
}: Readonly<{ row: AppIdentityRow; appId: string }>) {
  if (!row.apiKey) {
    return <span className="text-xs text-zinc-600">—</span>;
  }
  const display = row.apiKey.label || row.apiKey.keyPrefix || row.apiKey.id;
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <Link
        href={`/apps/${appId}/credentials`}
        className="font-mono text-xs text-zinc-300 hover:text-emerald-400 transition-colors"
        title={row.apiKey.keyPrefix ?? undefined}
      >
        {display.length > 22 ? `${display.slice(0, 20)}…` : display}
      </Link>
      {row.apiKeyCount > 1 ? (
        <span className="text-[10px] text-zinc-600">+{row.apiKeyCount - 1}</span>
      ) : null}
    </div>
  );
}

/**
 * Per-app M2M identities with cycle usage. Rows link to the identity
 * drill-down; the API key cell links back to the app's credentials.
 */
export default function IdentitiesTable({
  appId,
  identities,
}: Readonly<{ appId: string; identities: AppIdentityRow[] }>) {
  const [sortKey, setSortKey] = useState<SortKey>(DEFAULT_SORT);
  const sorted = useMemo(() => sortIdentities(identities, sortKey), [identities, sortKey]);

  if (identities.length === 0) {
    return (
      <div className="rounded-xl border border-zinc-800 bg-zinc-900/30 p-8 text-center">
        <p className="font-medium text-zinc-300">No identities yet</p>
        <p className="mt-1 text-sm text-zinc-500">
          Identities appear here once your app provisions an end user or one starts
          sending metered requests.
        </p>
      </div>
    );
  }

  return (
    <div className="overflow-x-auto rounded-xl border border-zinc-800 bg-zinc-900/30">
      <table className="w-full min-w-[52rem] text-sm">
        <thead>
          <tr className="border-b border-zinc-800 text-xs uppercase tracking-wider text-zinc-500">
            <th className="px-4 py-3 text-left font-medium sm:px-5">Identity</th>
            <th className="px-4 py-3 text-left font-medium sm:px-5">API key</th>
            <SortHeader
              label="Requests"
              sortKey="requests"
              activeKey={sortKey}
              onSort={setSortKey}
            />
            <SortHeader
              label="Duration"
              sortKey="duration"
              activeKey={sortKey}
              onSort={setSortKey}
            />
            <SortHeader
              label="Network fee"
              sortKey="fee"
              activeKey={sortKey}
              onSort={setSortKey}
            />
            <SortHeader
              label="Last active"
              sortKey="lastActive"
              activeKey={sortKey}
              onSort={setSortKey}
            />
            <th className="px-4 py-3 text-left font-medium sm:px-5">Status</th>
          </tr>
        </thead>
        <tbody>
          {sorted.map((row) => (
            <tr
              key={row.externalUserId}
              className="border-b border-zinc-800/50 last:border-b-0 hover:bg-zinc-800/20"
            >
              <td className="px-4 py-3 sm:px-5">
                <Link
                  href={`/apps/${appId}/identities/${encodeURIComponent(row.externalUserId)}`}
                  className="font-mono text-xs text-zinc-200 hover:text-emerald-400 transition-colors"
                  title={row.externalUserId}
                >
                  {row.externalUserId.length > 28
                    ? `${row.externalUserId.slice(0, 26)}…`
                    : row.externalUserId}
                </Link>
                {row.email ? (
                  <p className="mt-0.5 truncate text-[11px] text-zinc-600">{row.email}</p>
                ) : null}
              </td>
              <td className="px-4 py-3 sm:px-5">
                <IdentityApiKeyCell row={row} appId={appId} />
              </td>
              <td className="px-4 py-3 text-right tabular-nums text-zinc-300 sm:px-5">
                {row.requestCount.toLocaleString()}
              </td>
              <td className="px-4 py-3 text-right font-mono text-xs text-zinc-400 sm:px-5">
                {formatBillableDuration(row.billableSecs)}
              </td>
              <td className="px-4 py-3 text-right font-mono text-xs font-semibold text-emerald-400 sm:px-5">
                {formatUsdMicrosString(row.networkFeeUsdMicros) ?? "$0.00"}
              </td>
              <td className="px-4 py-3 text-right text-xs text-zinc-400 sm:px-5">
                {formatLastActive(row.lastActiveDate)}
              </td>
              <td className="px-4 py-3 sm:px-5">
                <span
                  className={`rounded px-1.5 py-0.5 text-[10px] uppercase tracking-wider ${statusBadgeClass(
                    statusLabel(row),
                  )}`}
                >
                  {statusLabel(row)}
                </span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
