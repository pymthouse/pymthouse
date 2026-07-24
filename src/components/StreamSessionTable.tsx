"use client";

import { useMemo } from "react";
import { formatIntegerString, weiHumanWithUnit } from "@/lib/format-wei";
import { formatUsdMicrosString } from "@/lib/format-usd-micros";

interface StreamSessionRow {
  id: string;
  manifestId: string;
  orchestratorAddress: string | null;
  /** Orchestrator priceInfo used for fee math (wei per pixelsPerUnit). */
  pricePerUnit: string | null;
  /** Orchestrator priceInfo denominator pixels. */
  pixelsPerUnit: string | null;
  /** Successful signer billing events (same dedupe as usage rows). */
  signerPaymentCount: number;
  totalFeeWei: string;
  /** Transaction-time USD micros for the session total, if available from billing events. */
  totalNetworkFeeUsdMicros?: string | null;
  /** Validated pipeline id, when available from billing events. */
  validatedPipeline?: string | null;
  /** Validated model id, when available from billing events. */
  validatedModelId?: string | null;
  status: string;
  startedAt: string;
  lastPaymentAt: string | null;
  endedAt: string | null;
}

interface StreamSessionTableProps {
  sessions: StreamSessionRow[];
}

function truncateAddress(addr: string | null): string {
  if (!addr) return "-";
  return `${addr.slice(0, 6)}...${addr.slice(-4)}`;
}

function timeAgo(dateStr: string): string {
  const now = Date.now();
  const then = new Date(dateStr).getTime();
  const seconds = Math.floor((now - then) / 1000);

  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
}

/** Most recent last payment first; rows with no payment sort last. */
function sortSessionsByLastPaymentDesc(
  rows: StreamSessionRow[],
): StreamSessionRow[] {
  return [...rows].sort((a, b) => {
    if (!a.lastPaymentAt && !b.lastPaymentAt) return 0;
    if (!a.lastPaymentAt) return 1;
    if (!b.lastPaymentAt) return -1;
    return (
      new Date(b.lastPaymentAt).getTime() - new Date(a.lastPaymentAt).getTime()
    );
  });
}

const statusBadge: Record<string, string> = {
  active: "bg-emerald-500/20 text-emerald-400",
  ended: "bg-zinc-500/20 text-zinc-400",
  error: "bg-red-500/20 text-red-400",
};

export default function StreamSessionTable({
  sessions,
}: Readonly<StreamSessionTableProps>) {
  const orderedSessions = useMemo(
    () => sortSessionsByLastPaymentDesc(sessions),
    [sessions],
  );

  if (orderedSessions.length === 0) {
    return (
      <div className="text-center py-12 text-zinc-500">
        <p>No stream sessions found</p>
      </div>
    );
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-zinc-800 text-zinc-500 text-xs uppercase tracking-wider">
            <th className="text-left py-3 px-4 font-medium">Manifest ID</th>
            <th className="text-left py-3 px-4 font-medium">Pipeline / Model</th>
            <th className="text-left py-3 px-4 font-medium">Orchestrator</th>
            <th className="text-right py-3 px-4 font-medium">Price / unit</th>
            <th className="text-right py-3 px-4 font-medium">Px / unit</th>
            <th className="text-right py-3 px-4 font-medium">Payments</th>
            <th className="text-right py-3 px-4 font-medium">Fee (wei)</th>
            <th className="text-right py-3 px-4 font-medium">Fee (USD)</th>
            <th className="text-center py-3 px-4 font-medium">Status</th>
            <th className="text-right py-3 px-4 font-medium">Started</th>
            <th className="text-right py-3 px-4 font-medium">Last Payment</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-zinc-800/50">
          {orderedSessions.map((s) => {
            const feeUsd = formatUsdMicrosString(s.totalNetworkFeeUsdMicros ?? null, 6);
            return (
              <tr
                key={s.id}
                className="hover:bg-zinc-900/50 transition-colors"
              >
                <td className="py-3 px-4 font-mono text-zinc-300 text-xs">
                  {s.manifestId.length > 16
                    ? `${s.manifestId.slice(0, 8)}...${s.manifestId.slice(-4)}`
                    : s.manifestId}
                </td>
                <td className="py-3 px-4 text-xs">
                  {s.validatedPipeline ? (
                    <div>
                      <span className="text-zinc-200">{s.validatedPipeline}</span>
                      {s.validatedModelId && (
                        <div className="text-zinc-500 truncate max-w-[120px]" title={s.validatedModelId}>
                          {s.validatedModelId}
                        </div>
                      )}
                    </div>
                  ) : (
                    <span className="text-zinc-600">—</span>
                  )}
                </td>
                <td className="py-3 px-4 font-mono text-zinc-400 text-xs">
                  {truncateAddress(s.orchestratorAddress)}
                </td>
                <td className="py-3 px-4 text-right text-zinc-400 font-mono text-xs">
                  {s.pricePerUnit != null && s.pricePerUnit !== ""
                    ? weiHumanWithUnit(s.pricePerUnit)
                    : "—"}
                </td>
                <td className="py-3 px-4 text-right text-zinc-400 font-mono text-xs">
                  {formatIntegerString(s.pixelsPerUnit) ?? "—"}
                </td>
                <td className="py-3 px-4 text-right text-zinc-300 tabular-nums">
                  {s.signerPaymentCount.toLocaleString()}
                </td>
                <td className="py-3 px-4 text-right text-zinc-300 font-mono text-xs">
                  {weiHumanWithUnit(s.totalFeeWei)}
                </td>
                <td className="py-3 px-4 text-right text-zinc-300 font-mono text-xs">
                  {feeUsd ? <span>{feeUsd}</span> : <span className="text-zinc-600">—</span>}
                </td>
                <td className="py-3 px-4 text-center">
                  <span
                    className={`px-2 py-0.5 text-xs font-medium rounded-full ${
                      statusBadge[s.status] || statusBadge.ended
                    }`}
                  >
                    {s.status}
                  </span>
                </td>
                <td className="py-3 px-4 text-right text-zinc-500 text-xs">
                  {timeAgo(s.startedAt)}
                </td>
                <td className="py-3 px-4 text-right text-zinc-500 text-xs">
                  {s.lastPaymentAt ? timeAgo(s.lastPaymentAt) : "-"}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
