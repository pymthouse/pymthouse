"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

import {
  formatExactUsdMicrosString,
  formatUsdFromWei,
  formatUsdMicrosString,
} from "@/lib/format-usd-micros";
import type {
  SignedTicketRequestRow,
  SignedTicketSessionRow,
} from "@/lib/openmeter/signed-ticket-events";

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

function historyCopy(scope: HistoryScope): {
  title: string;
  subtitle: string;
  emptySessions: string;
  emptyRequests: string;
} {
  if (scope === "all") {
    return {
      title: "Signed ticket requests",
      subtitle:
        "Platform-wide signed ticket sessions (and requests), newest first. Filtered by the application selector when a subset is selected.",
      emptySessions:
        "No signed ticket sessions for the selected apps in this billing cycle.",
      emptyRequests:
        "No signed ticket requests for the selected apps in this billing cycle.",
    };
  }
  return {
    title: "Your signed ticket requests",
    subtitle: "Only sessions and requests billed to your usage identity.",
    emptySessions:
      "No signed ticket sessions for your usage identity in this billing cycle.",
    emptyRequests:
      "No signed ticket requests for your usage identity in this billing cycle.",
  };
}

function pipelineModelLabel(pipeline: string, modelId: string): string {
  return modelId && modelId !== "unknown" ? `${pipeline} / ${modelId}` : pipeline;
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
}: Readonly<{ row: SignedTicketRequestRow; compact?: boolean }>) {
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

function RequestTable({
  items,
  nextCursor,
  loadingMore,
  onLoadMore,
  compact,
}: Readonly<{
  items: SignedTicketRequestRow[];
  nextCursor: string | null;
  loadingMore: boolean;
  onLoadMore: () => void;
  compact?: boolean;
}>) {
  return (
    <>
      <div className="overflow-x-auto -mx-1">
        <table className="w-full min-w-[640px] text-left text-sm">
          <thead>
            <tr className="border-b border-zinc-800 text-xs uppercase tracking-wider text-zinc-500">
              <th className="px-2 py-2 font-medium">Time</th>
              {!compact ? <th className="px-2 py-2 font-medium">App</th> : null}
              <th className="px-2 py-2 font-medium">Request ID</th>
              <th className="px-2 py-2 font-medium">Pipeline / Model</th>
              <th className="px-2 py-2 font-medium text-right">Network fee</th>
            </tr>
          </thead>
          <tbody>
            {items.map((row) => (
              <RequestRow key={row.eventId} row={row} compact={compact} />
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

export default function SignedTicketRequestHistory({
  clientId,
  clientIds,
  historyScope = "own",
}: Readonly<{
  /** Public OIDC client_id when scoped to a single app. */
  clientId?: string | null;
  /** Public OIDC client_ids when scoped to a subset of apps. */
  clientIds?: string[] | null;
  /**
   * `own` — viewer usage subjects only (default).
   * `all` — platform-wide history for admins (All Usage tab).
   */
  historyScope?: HistoryScope;
}>) {
  const [viewMode, setViewMode] = useState<ViewMode>("session");
  const [sessions, setSessions] = useState<SignedTicketSessionRow[]>([]);
  const [requests, setRequests] = useState<SignedTicketRequestRow[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [openMeterConfigured, setOpenMeterConfigured] = useState(true);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const copy = historyCopy(historyScope);

  const resolvedClientIds = useMemo(
    () => normalizeClientIds(clientId, clientIds),
    [clientId, clientIds],
  );
  const clientIdsKey = resolvedClientIds.join(",");

  const fetchPage = useCallback(
    async (cursor: string | null, mode: ViewMode) => {
      const params = new URLSearchParams();
      params.set("limit", "25");
      params.set("scope", historyScope);
      params.set("groupBy", mode);
      if (cursor) {
        params.set("cursor", cursor);
      }
      for (const id of resolvedClientIds) {
        params.append("clientId", id);
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
    [resolvedClientIds, historyScope],
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
        setOpenMeterConfigured(page.openMeterConfigured);
        setNextCursor(page.nextCursor);
        if (page.mode === "session") {
          setSessions(page.items as SignedTicketSessionRow[]);
        } else {
          setRequests(page.items as SignedTicketRequestRow[]);
        }
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
  }, [fetchPage, clientIdsKey, historyScope, viewMode]);

  async function onLoadMore() {
    if (!nextCursor || loadingMore) {
      return;
    }
    setLoadingMore(true);
    setError(null);
    try {
      const page = await fetchPage(nextCursor, viewMode);
      setOpenMeterConfigured(page.openMeterConfigured);
      setNextCursor(page.nextCursor);
      if (page.mode === "session") {
        setSessions((prev) => [
          ...prev,
          ...(page.items as SignedTicketSessionRow[]),
        ]);
      } else {
        setRequests((prev) => [
          ...prev,
          ...(page.items as SignedTicketRequestRow[]),
        ]);
      }
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
      <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h2 className="text-sm font-semibold text-zinc-200">{copy.title}</h2>
          <p className="text-xs text-zinc-500 mt-1">{copy.subtitle}</p>
        </div>
        <div className="inline-flex rounded-lg border border-zinc-700 p-0.5 self-start">
          <button
            type="button"
            onClick={() => setViewMode("session")}
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
            onClick={() => setViewMode("request")}
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

      {!openMeterConfigured ? (
        <p className="text-sm text-zinc-500 py-6 text-center">
          OpenMeter is not configured, so per-request history is unavailable.
        </p>
      ) : null}
      {openMeterConfigured && loading ? (
        <div className="animate-pulse space-y-3 py-2">
          {["a", "b", "c"].map((key) => (
            <div key={key} className="h-10 rounded-lg bg-zinc-800/80" />
          ))}
        </div>
      ) : null}
      {openMeterConfigured && !loading && error ? (
        <p className="text-sm text-rose-400 py-4 text-center">{error}</p>
      ) : null}
      {openMeterConfigured && !loading && !error && itemsEmpty ? (
        <p className="text-sm text-zinc-500 py-6 text-center">{emptyCopy}</p>
      ) : null}
      {openMeterConfigured && !loading && !error && !itemsEmpty && viewMode === "session" ? (
        <SessionTable
          items={sessions}
          nextCursor={nextCursor}
          loadingMore={loadingMore}
          onLoadMore={() => void onLoadMore()}
          historyScope={historyScope}
          resolvedClientIds={resolvedClientIds}
        />
      ) : null}
      {openMeterConfigured && !loading && !error && !itemsEmpty && viewMode === "request" ? (
        <RequestTable
          items={requests}
          nextCursor={nextCursor}
          loadingMore={loadingMore}
          onLoadMore={() => void onLoadMore()}
        />
      ) : null}
    </section>
  );
}
