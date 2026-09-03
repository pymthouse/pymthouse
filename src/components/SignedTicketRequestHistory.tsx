"use client";

import Link from "next/link";
import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type Dispatch,
  type SetStateAction,
} from "react";

import {
  formatExactUsdMicrosString,
  formatUsdFromWei,
  formatUsdMicrosString,
  formatUsdMicrosSummary,
} from "@/lib/format-usd-micros";
import { truncateMiddle } from "@/lib/truncate-middle";
import {
  buildRequestsCsv,
  buildRequestsCsvFilename,
  sumRequestFeeUsdMicros,
} from "@/lib/usage/requests-csv";
import type {
  SignedTicketRequestRow,
  SignedTicketSessionRow,
} from "@/lib/openmeter/signed-ticket-events";
import { formatUsageCapabilityLabel } from "@/lib/openmeter/usage-capability";

type RequestsResponse = {
  items: SignedTicketRequestRow[];
  nextCursor: string | null;
  openMeterConfigured: boolean;
  error?: string;
};

type SessionsResponse = {
  items: SignedTicketSessionRow[];
  nextCursor: string | null;
  openMeterConfigured: boolean;
  error?: string;
};

type HistoryScope = "own" | "all";
type ViewMode = "session" | "request";

function formatRequestTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) {
    return iso;
  }
  return d.toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    timeZoneName: "short",
  });
}

function shortenId(value: string, keep = 10): string {
  if (value.length <= keep * 2 + 1) {
    return value;
  }
  return `${value.slice(0, keep)}…${value.slice(-6)}`;
}

function normalizeClientIds(
  clientId?: string | null,
  clientIds?: string[] | null,
): string[] {
  return [
    ...new Set(
      [...(clientIds ?? []), ...(clientId ? [clientId] : [])]
        .map((id) => id.trim())
        .filter((id) => id.length > 0),
    ),
  ].sort((a, b) => a.localeCompare(b));
}

function historyCopy(
  scope: HistoryScope,
  identityIds: string[],
): {
  title: string;
  /** Scope shown as a chip beside the title, not as prose. */
  scopeChip: string;
  /** Chip holds a raw identity id, so render it monospaced. */
  scopeChipMono?: boolean;
  emptySessions: string;
  emptyRequests: string;
} {
  if (identityIds.length === 1) {
    return {
      title: "Requests",
      scopeChip: identityIds[0],
      scopeChipMono: true,
      emptySessions: "No sessions for this identity in this billing cycle.",
      emptyRequests: "No requests for this identity in this billing cycle.",
    };
  }
  if (identityIds.length > 1) {
    return {
      title: "Requests",
      scopeChip: `${identityIds.length} identities`,
      emptySessions:
        "No sessions for the selected identities in this billing cycle.",
      emptyRequests:
        "No requests for the selected identities in this billing cycle.",
    };
  }
  if (scope === "all") {
    return {
      title: "Requests",
      scopeChip: "All identities",
      emptySessions: "No sessions for the selected apps in this billing cycle.",
      emptyRequests: "No requests for the selected apps in this billing cycle.",
    };
  }
  return {
    title: "Requests",
    scopeChip: "All identities on your apps",
    emptySessions: "No sessions for your apps in this billing cycle.",
    emptyRequests: "No requests for your apps in this billing cycle.",
  };
}

function pipelineModelLabel(pipeline: string, modelId: string): string {
  return formatUsageCapabilityLabel(pipeline, modelId);
}

function requestFeeLabel(row: SignedTicketRequestRow): string {
  const fromWei = formatUsdFromWei(row.feeWei, row.ethUsdPrice);
  if (fromWei) return fromWei;
  // Exact ingest may store fractional micros (e.g. "0.932"); the integer-only
  // formatter would treat those as invalid and the row would falsely show $0.
  return formatExactUsdMicrosString(row.networkFeeUsdMicros) ?? "$0";
}

function requestFeeTitle(row: SignedTicketRequestRow): string {
  const parts = [requestFeeLabel(row)];
  if (row.feeWei) parts.push(`fee_wei=${row.feeWei}`);
  if (row.ethUsdPrice) parts.push(`eth_usd=${row.ethUsdPrice}`);
  if (row.networkFeeUsdMicros) parts.push(`micros=${row.networkFeeUsdMicros}`);
  return parts.join(" · ");
}

function RequestRow({
  row,
  compact,
  showIdentity,
}: Readonly<{
  row: SignedTicketRequestRow;
  compact?: boolean;
  showIdentity?: boolean;
}>) {
  const feeLabel = requestFeeLabel(row);
  const pipelineLabel = pipelineModelLabel(row.pipeline, row.modelId);
  return (
    <tr className="border-b border-zinc-800/60 last:border-0">
      <td className="px-2 py-3 text-zinc-300 whitespace-nowrap align-top">
        {formatRequestTime(row.time)}
      </td>
      {!compact ? (
        <td className="px-2 py-3 text-zinc-300 align-top">
          <div className="truncate max-w-[10rem]" title={row.appName || row.clientId}>
            {row.appName || row.clientId}
          </div>
        </td>
      ) : null}
      {showIdentity ? (
        <td className="px-2 py-3 align-top">
          {row.externalUserId ? (
            <Link
              href={`/apps/${encodeURIComponent(row.clientId)}/identities/${encodeURIComponent(row.externalUserId)}`}
              className="block max-w-[10rem] font-mono text-xs text-zinc-400 transition-colors hover:text-emerald-400"
              title={row.externalUserId}
            >
              {truncateMiddle(row.externalUserId, 20)}
            </Link>
          ) : (
            <span className="text-xs text-zinc-600">—</span>
          )}
        </td>
      ) : null}
      <td className="px-2 py-3 font-mono text-xs text-zinc-400 align-top">
        <span title={row.gatewayRequestId}>{shortenId(row.gatewayRequestId)}</span>
      </td>
      <td
        className="px-2 py-3 text-zinc-400 align-top truncate max-w-[14rem]"
        title={pipelineLabel}
      >
        {pipelineLabel}
      </td>
      <td
        className="px-2 py-3 text-right font-mono text-emerald-400/90 align-top whitespace-nowrap"
        title={requestFeeTitle(row)}
      >
        {feeLabel}
      </td>
    </tr>
  );
}

/** Columns before Request ID, so the footer can span them correctly. */
function leadingColumnCount(compact?: boolean, showIdentity?: boolean): number {
  // Time is always present; App and Identity are conditional.
  return 1 + (compact ? 0 : 1) + (showIdentity ? 1 : 0);
}

export function RequestTable({
  items,
  nextCursor,
  loadingMore,
  onLoadMore,
  compact,
  showIdentity,
}: Readonly<{
  items: SignedTicketRequestRow[];
  nextCursor: string | null;
  loadingMore: boolean;
  onLoadMore: () => void;
  compact?: boolean;
  /** Render the identity column (hidden when every row is one known identity). */
  showIdentity?: boolean;
}>) {
  return (
    <>
      <div className="overflow-x-auto -mx-1">
        <table className="w-full min-w-[640px] text-left text-sm">
          <thead>
            <tr className="border-b border-zinc-800 text-xs uppercase tracking-wider text-zinc-500">
              <th className="px-2 py-2 font-medium">Time</th>
              {!compact ? <th className="px-2 py-2 font-medium">App</th> : null}
              {showIdentity ? (
                <th className="px-2 py-2 font-medium">Identity</th>
              ) : null}
              <th className="px-2 py-2 font-medium">Request ID</th>
              <th className="px-2 py-2 font-medium">Pipeline / Model</th>
              <th className="px-2 py-2 font-medium text-right">Network fee</th>
            </tr>
          </thead>
          <tbody>
            {items.map((row) => (
              <RequestRow
                key={row.eventId}
                row={row}
                compact={compact}
                showIdentity={showIdentity}
              />
            ))}
          </tbody>
          <tfoot>
            <tr className="border-t border-zinc-700 text-xs">
              <th
                scope="row"
                className="px-2 py-2.5 text-left font-medium text-zinc-400"
                colSpan={leadingColumnCount(compact, showIdentity) + 2}
              >
                {items.length.toLocaleString("en-US")} request
                {items.length === 1 ? "" : "s"}
                {nextCursor ? (
                  <span className="ml-1.5 text-zinc-600">
                    loaded — load more to include the rest of the cycle
                  </span>
                ) : (
                  <span className="ml-1.5 text-zinc-600">· complete for this range</span>
                )}
              </th>
              <td className="px-2 py-2.5 text-right font-mono tabular-nums text-zinc-200">
                {formatUsdMicrosSummary(sumRequestFeeUsdMicros(items))}
              </td>
            </tr>
          </tfoot>
        </table>
      </div>

      {nextCursor ? (
        <div className="mt-4 flex justify-center">
          <button
            type="button"
            onClick={onLoadMore}
            disabled={loadingMore}
            className="px-4 py-2 rounded-lg text-xs font-semibold bg-zinc-800 text-zinc-200 hover:bg-zinc-700 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {loadingMore ? "Loading…" : "Load more"}
          </button>
        </div>
      ) : null}
    </>
  );
}

function SessionDetail({
  session,
  historyScope,
  resolvedClientIds,
}: Readonly<{
  session: SignedTicketSessionRow;
  historyScope: HistoryScope;
  resolvedClientIds: string[];
}>) {
  const [items, setItems] = useState<SignedTicketRequestRow[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchPage = useCallback(
    async (cursor: string | null, append: boolean) => {
      const params = new URLSearchParams();
      params.set("limit", "25");
      params.set("scope", historyScope);
      params.set("groupBy", "request");
      params.set("manifestId", session.manifestId);
      if (cursor) params.set("cursor", cursor);
      for (const id of resolvedClientIds) {
        params.append("clientId", id);
      }

      const res = await fetch(`/api/v1/me/usage/requests?${params.toString()}`, {
        method: "GET",
        credentials: "same-origin",
      });
      const body = (await res.json().catch(() => null)) as RequestsResponse | null;
      if (!res.ok) {
        throw new Error(body?.error || `Request failed (${res.status})`);
      }
      if (!body) {
        throw new Error("Empty response");
      }
      setNextCursor(body.nextCursor);
      setItems((prev) => (append ? [...prev, ...body.items] : body.items));
    },
    [historyScope, resolvedClientIds, session.manifestId],
  );

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    fetchPage(null, false)
      .catch((err: unknown) => {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : "Failed to load requests");
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [fetchPage]);

  async function onLoadMore() {
    if (!nextCursor || loadingMore) return;
    setLoadingMore(true);
    try {
      await fetchPage(nextCursor, true);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Failed to load more");
    } finally {
      setLoadingMore(false);
    }
  }

  if (loading) {
    return (
      <div className="animate-pulse space-y-2 py-2 px-2">
        <div className="h-8 rounded bg-zinc-800/80" />
        <div className="h-8 rounded bg-zinc-800/80" />
      </div>
    );
  }
  if (error) {
    return <p className="text-sm text-rose-400 py-3 px-2">{error}</p>;
  }
  if (items.length === 0) {
    return (
      <p className="text-sm text-zinc-500 py-3 px-2">
        No request detail loaded for this session yet (events may still be ingesting).
      </p>
    );
  }
  return (
    <div className="px-1 pb-3">
      <RequestTable
        items={items}
        nextCursor={nextCursor}
        loadingMore={loadingMore}
        onLoadMore={() => void onLoadMore()}
        compact
      />
    </div>
  );
}

function SessionRow({
  session,
  expanded,
  onToggle,
  historyScope,
  resolvedClientIds,
}: Readonly<{
  session: SignedTicketSessionRow;
  expanded: boolean;
  onToggle: () => void;
  historyScope: HistoryScope;
  resolvedClientIds: string[];
}>) {
  const feeLabel =
    formatUsdMicrosString(session.networkFeeUsdMicros, 4) ?? "$0";
  const pipelineLabel = pipelineModelLabel(session.pipeline, session.modelId);
  const feeTitle = [
    feeLabel,
    `exact=${session.networkFeeUsdExact} micros`,
    `fee_wei=${session.feeWei}`,
  ].join(" · ");
  const startedLabel = session.startedAt
    ? formatRequestTime(session.startedAt)
    : "—";
  const durationLabel =
    session.billableSecs && session.billableSecs !== "0"
      ? `${session.billableSecs}s`
      : "—";

  return (
    <>
      <tr className="border-b border-zinc-800/60">
        <td className="px-2 py-3 align-top">
          <button
            type="button"
            onClick={onToggle}
            className="text-zinc-400 hover:text-zinc-200 text-xs font-semibold"
            aria-expanded={expanded}
            aria-label={expanded ? "Collapse session" : "Expand session"}
          >
            {expanded ? "▾" : "▸"}
          </button>
        </td>
        <td className="px-2 py-3 text-zinc-300 align-top whitespace-nowrap">
          <div title={session.startedAt || undefined}>{startedLabel}</div>
          <div
            className="font-mono text-xs text-zinc-500 mt-0.5"
            title={session.manifestId}
          >
            {shortenId(session.manifestId)}
          </div>
        </td>
        <td className="px-2 py-3 text-zinc-300 align-top">
          <div
            className="truncate max-w-[10rem]"
            title={session.appName || session.clientId}
          >
            {session.appName || session.clientId}
          </div>
        </td>
        <td
          className="px-2 py-3 text-zinc-400 align-top truncate max-w-[14rem]"
          title={pipelineLabel}
        >
          {pipelineLabel}
        </td>
        <td className="px-2 py-3 text-right font-mono text-xs text-zinc-400 align-top whitespace-nowrap">
          {durationLabel}
        </td>
        <td
          className="px-2 py-3 text-right font-mono text-emerald-400/90 align-top whitespace-nowrap"
          title={feeTitle}
        >
          {feeLabel}
        </td>
      </tr>
      {expanded ? (
        <tr className="border-b border-zinc-800/60 bg-zinc-950/40">
          <td colSpan={6} className="px-0 py-0">
            <SessionDetail
              session={session}
              historyScope={historyScope}
              resolvedClientIds={resolvedClientIds}
            />
          </td>
        </tr>
      ) : null}
    </>
  );
}

function SessionTable({
  items,
  nextCursor,
  loadingMore,
  onLoadMore,
  historyScope,
  resolvedClientIds,
}: Readonly<{
  items: SignedTicketSessionRow[];
  nextCursor: string | null;
  loadingMore: boolean;
  onLoadMore: () => void;
  historyScope: HistoryScope;
  resolvedClientIds: string[];
}>) {
  const [expanded, setExpanded] = useState<string | null>(null);

  return (
    <>
      <div className="overflow-x-auto -mx-1">
        <table className="w-full min-w-[720px] text-left text-sm">
          <thead>
            <tr className="border-b border-zinc-800 text-xs uppercase tracking-wider text-zinc-500">
              <th className="px-2 py-2 font-medium w-8" />
              <th className="px-2 py-2 font-medium">Started</th>
              <th className="px-2 py-2 font-medium">App</th>
              <th className="px-2 py-2 font-medium">Pipeline / Model</th>
              <th className="px-2 py-2 font-medium text-right">Duration</th>
              <th className="px-2 py-2 font-medium text-right">Network fee</th>
            </tr>
          </thead>
          <tbody>
            {items.map((session) => (
              <SessionRow
                key={`${session.clientId}:${session.manifestId}`}
                session={session}
                expanded={expanded === `${session.clientId}:${session.manifestId}`}
                onToggle={() => {
                  const key = `${session.clientId}:${session.manifestId}`;
                  setExpanded((prev) => (prev === key ? null : key));
                }}
                historyScope={historyScope}
                resolvedClientIds={resolvedClientIds}
              />
            ))}
          </tbody>
        </table>
      </div>

      {nextCursor ? (
        <div className="mt-4 flex justify-center">
          <button
            type="button"
            onClick={onLoadMore}
            disabled={loadingMore}
            className="px-4 py-2 rounded-lg text-xs font-semibold bg-zinc-800 text-zinc-200 hover:bg-zinc-700 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {loadingMore ? "Loading…" : "Load more"}
          </button>
        </div>
      ) : null}
    </>
  );
}

type HistoryPageResult = {
  openMeterConfigured: boolean;
  nextCursor: string | null;
  items: SignedTicketSessionRow[] | SignedTicketRequestRow[];
  mode: ViewMode;
};

function applyHistoryPage(
  page: HistoryPageResult,
  append: boolean,
  setOpenMeterConfigured: (value: boolean) => void,
  setNextCursor: (value: string | null) => void,
  setSessions: Dispatch<SetStateAction<SignedTicketSessionRow[]>>,
  setRequests: Dispatch<SetStateAction<SignedTicketRequestRow[]>>,
): void {
  setOpenMeterConfigured(page.openMeterConfigured);
  setNextCursor(page.nextCursor);
  if (page.mode === "session") {
    const rows = page.items as SignedTicketSessionRow[];
    setSessions((prev) => (append ? [...prev, ...rows] : rows));
    return;
  }
  const rows = page.items as SignedTicketRequestRow[];
  setRequests((prev) => (append ? [...prev, ...rows] : rows));
}

function downloadRequestsCsv(requests: SignedTicketRequestRow[]): void {
  const csv = buildRequestsCsv(requests);
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = buildRequestsCsvFilename();
  anchor.click();
  // Revoke after the click task so the browser can start the download first.
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

function HistoryToolbar({
  copy,
  fromDate,
  toDate,
  rangeActive,
  identityFilterActive,
  viewMode,
  requests,
  onFromDateChange,
  onToDateChange,
  onClearRange,
  onClearIdentityFilter,
  onDownloadCsv,
  onViewModeChange,
}: Readonly<{
  copy: ReturnType<typeof historyCopy>;
  fromDate: string;
  toDate: string;
  rangeActive: boolean;
  identityFilterActive: boolean;
  viewMode: ViewMode;
  requests: SignedTicketRequestRow[];
  onFromDateChange: (value: string) => void;
  onToDateChange: (value: string) => void;
  onClearRange: () => void;
  onClearIdentityFilter?: () => void;
  onDownloadCsv: () => void;
  onViewModeChange: (mode: ViewMode) => void;
}>) {
  return (
    <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="text-sm font-semibold text-zinc-200">{copy.title}</h2>
          <span
            className="inline-flex max-w-full items-center gap-1 rounded-full border border-zinc-700 bg-black/20 px-2 py-0.5 text-[11px] text-zinc-400"
            title={
              identityFilterActive
                ? `Rows are limited to ${copy.scopeChip}. Change it with the Identities filter above.`
                : "Rows cover every identity on the selected apps. Narrow them with the Identities filter above."
            }
          >
            <span className="text-zinc-600">Scope</span>
            <span className={`truncate ${copy.scopeChipMono ? "font-mono" : ""}`}>
              {copy.scopeChipMono ? truncateMiddle(copy.scopeChip, 24) : copy.scopeChip}
            </span>
          </span>
          {identityFilterActive && onClearIdentityFilter ? (
            <button
              type="button"
              onClick={onClearIdentityFilter}
              className="text-[11px] text-zinc-500 underline-offset-2 hover:text-zinc-300 hover:underline"
            >
              Show all identities
            </button>
          ) : null}
        </div>
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <label className="flex items-center gap-1 text-[11px] text-zinc-500">
            <span className="sr-only">From date</span>
            <input
              type="date"
              value={fromDate}
              max={toDate || undefined}
              onChange={(e) => onFromDateChange(e.target.value)}
              className="rounded-md border border-zinc-700 bg-black/20 px-2 py-1 text-[11px] text-zinc-300"
            />
          </label>
          <span className="text-[11px] text-zinc-600">→</span>
          <label className="flex items-center gap-1 text-[11px] text-zinc-500">
            <span className="sr-only">To date</span>
            <input
              type="date"
              value={toDate}
              min={fromDate || undefined}
              onChange={(e) => onToDateChange(e.target.value)}
              className="rounded-md border border-zinc-700 bg-black/20 px-2 py-1 text-[11px] text-zinc-300"
            />
          </label>
          {rangeActive ? (
            <button
              type="button"
              onClick={onClearRange}
              className="text-[11px] text-zinc-500 underline-offset-2 hover:text-zinc-300 hover:underline"
            >
              Clear range
            </button>
          ) : null}
          {viewMode === "request" && requests.length > 0 ? (
            <button
              type="button"
              onClick={onDownloadCsv}
              className="rounded-md border border-zinc-700 px-2 py-1 text-[11px] text-zinc-300 transition-colors hover:border-emerald-500/40 hover:text-emerald-300"
            >
              Export CSV
            </button>
          ) : null}
        </div>
      </div>
      <div className="inline-flex rounded-lg border border-zinc-700 p-0.5 self-start">
        <button
          type="button"
          onClick={() => onViewModeChange("session")}
          className={`px-3 py-1.5 rounded-md text-xs font-semibold ${
            viewMode === "session"
              ? "bg-zinc-700 text-zinc-100"
              : "text-zinc-400 hover:text-zinc-200"
          }`}
        >
          Sessions
        </button>
        <button
          type="button"
          onClick={() => onViewModeChange("request")}
          className={`px-3 py-1.5 rounded-md text-xs font-semibold ${
            viewMode === "request"
              ? "bg-zinc-700 text-zinc-100"
              : "text-zinc-400 hover:text-zinc-200"
          }`}
        >
          All requests
        </button>
      </div>
    </div>
  );
}

function HistoryBody({
  openMeterConfigured,
  loading,
  error,
  itemsEmpty,
  emptyCopy,
  viewMode,
  sessions,
  requests,
  nextCursor,
  loadingMore,
  onLoadMore,
  historyScope,
  resolvedClientIds,
}: Readonly<{
  openMeterConfigured: boolean;
  loading: boolean;
  error: string | null;
  itemsEmpty: boolean;
  emptyCopy: string;
  viewMode: ViewMode;
  sessions: SignedTicketSessionRow[];
  requests: SignedTicketRequestRow[];
  nextCursor: string | null;
  loadingMore: boolean;
  onLoadMore: () => void;
  historyScope: HistoryScope;
  resolvedClientIds: string[];
}>) {
  if (!openMeterConfigured) {
    return (
      <p className="text-sm text-zinc-500 py-6 text-center">
        Usage metering is not configured, so per-request history is unavailable.
      </p>
    );
  }
  if (loading) {
    return (
      <div className="animate-pulse space-y-3 py-2">
        {["a", "b", "c"].map((key) => (
          <div key={key} className="h-10 rounded-lg bg-zinc-800/80" />
        ))}
      </div>
    );
  }
  if (error) {
    return <p className="text-sm text-rose-400 py-4 text-center">{error}</p>;
  }
  if (itemsEmpty) {
    return <p className="text-sm text-zinc-500 py-6 text-center">{emptyCopy}</p>;
  }
  if (viewMode === "session") {
    return (
      <SessionTable
        items={sessions}
        nextCursor={nextCursor}
        loadingMore={loadingMore}
        onLoadMore={onLoadMore}
        historyScope={historyScope}
        resolvedClientIds={resolvedClientIds}
      />
    );
  }
  return (
    <RequestTable
      items={requests}
      nextCursor={nextCursor}
      loadingMore={loadingMore}
      onLoadMore={onLoadMore}
      showIdentity
    />
  );
}

export default function SignedTicketRequestHistory({
  clientId,
  clientIds,
  historyScope = "own",
  externalUserIds,
  onClearIdentityFilter,
}: Readonly<{
  /** Public OIDC client_id when scoped to a single app. */
  clientId?: string | null;
  /** Public OIDC client_ids when scoped to a subset of apps. */
  clientIds?: string[] | null;
  /**
   * `own` — apps the viewer owns or administers, every identity (default).
   * `all` — platform-wide history for admins (All Usage tab).
   */
  historyScope?: HistoryScope;
  /** Identity filter (external_user_id); empty means all identities. */
  externalUserIds?: string[] | null;
  /** Resets the page-level Identities filter from inside this panel. */
  onClearIdentityFilter?: () => void;
}>) {
  const [viewMode, setViewMode] = useState<ViewMode>("session");
  const [sessions, setSessions] = useState<SignedTicketSessionRow[]>([]);
  const [requests, setRequests] = useState<SignedTicketRequestRow[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [openMeterConfigured, setOpenMeterConfigured] = useState(true);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fromDate, setFromDate] = useState("");
  const [toDate, setToDate] = useState("");

  const resolvedIdentityIds = useMemo(
    () =>
      [
        ...new Set(
          (externalUserIds ?? []).map((id) => id.trim()).filter(Boolean),
        ),
      ].sort((a, b) => a.localeCompare(b)),
    [externalUserIds],
  );
  const identityIdsKey = resolvedIdentityIds.join(",");

  const copy = historyCopy(historyScope, resolvedIdentityIds);
  // Both bounds are required together; the API rejects a half-open range.
  const rangeActive = Boolean(fromDate && toDate);

  const resolvedClientIds = useMemo(
    () => normalizeClientIds(clientId, clientIds),
    [clientId, clientIds],
  );
  const clientIdsKey = resolvedClientIds.join(",");

  const downloadCsv = useCallback(() => {
    downloadRequestsCsv(requests);
  }, [requests]);

  const fetchPage = useCallback(
    async (cursor: string | null, mode: ViewMode): Promise<HistoryPageResult> => {
      const params = new URLSearchParams();
      params.set("limit", "25");
      params.set("scope", historyScope);
      params.set("groupBy", mode);
      if (cursor) {
        params.set("cursor", cursor);
      }
      if (fromDate && toDate) {
        params.set("from", fromDate);
        params.set("to", toDate);
      }
      for (const id of resolvedClientIds) {
        params.append("clientId", id);
      }
      for (const id of resolvedIdentityIds) {
        params.append("externalUserId", id);
      }

      const res = await fetch(`/api/v1/me/usage/requests?${params.toString()}`, {
        method: "GET",
        credentials: "same-origin",
      });
      const body = (await res.json().catch(() => null)) as
        | (RequestsResponse & SessionsResponse)
        | null;
      if (!res.ok) {
        throw new Error(body?.error || `Request failed (${res.status})`);
      }
      if (!body) {
        throw new Error("Empty response");
      }

      return {
        openMeterConfigured: body.openMeterConfigured !== false,
        nextCursor: body.nextCursor,
        items: body.items,
        mode,
      };
    },
    [resolvedClientIds, resolvedIdentityIds, historyScope, fromDate, toDate],
  );

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    setSessions([]);
    setRequests([]);
    setNextCursor(null);

    fetchPage(null, viewMode)
      .then((page) => {
        if (cancelled) return;
        applyHistoryPage(
          page,
          false,
          setOpenMeterConfigured,
          setNextCursor,
          setSessions,
          setRequests,
        );
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : "Failed to load history");
        }
      })
      .finally(() => {
        if (!cancelled) {
          setLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [
    fetchPage,
    clientIdsKey,
    identityIdsKey,
    historyScope,
    viewMode,
    fromDate,
    toDate,
  ]);

  async function onLoadMore() {
    if (!nextCursor || loadingMore) {
      return;
    }
    setLoadingMore(true);
    setError(null);
    try {
      const page = await fetchPage(nextCursor, viewMode);
      applyHistoryPage(
        page,
        true,
        setOpenMeterConfigured,
        setNextCursor,
        setSessions,
        setRequests,
      );
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Failed to load more");
    } finally {
      setLoadingMore(false);
    }
  }

  const emptyCopy =
    viewMode === "session" ? copy.emptySessions : copy.emptyRequests;
  const itemsEmpty =
    viewMode === "session" ? sessions.length === 0 : requests.length === 0;

  return (
    <section className="rounded-xl border border-zinc-800 bg-zinc-900/30 p-4 sm:p-5">
      <HistoryToolbar
        copy={copy}
        fromDate={fromDate}
        toDate={toDate}
        rangeActive={rangeActive}
        identityFilterActive={resolvedIdentityIds.length > 0}
        viewMode={viewMode}
        requests={requests}
        onFromDateChange={setFromDate}
        onToDateChange={setToDate}
        onClearRange={() => {
          setFromDate("");
          setToDate("");
        }}
        onClearIdentityFilter={onClearIdentityFilter}
        onDownloadCsv={downloadCsv}
        onViewModeChange={setViewMode}
      />

      <HistoryBody
        openMeterConfigured={openMeterConfigured}
        loading={loading}
        error={error}
        itemsEmpty={itemsEmpty}
        emptyCopy={emptyCopy}
        viewMode={viewMode}
        sessions={sessions}
        requests={requests}
        nextCursor={nextCursor}
        loadingMore={loadingMore}
        onLoadMore={() => void onLoadMore()}
        historyScope={historyScope}
        resolvedClientIds={resolvedClientIds}
      />
    </section>
  );
}
