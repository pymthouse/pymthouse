"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

import { formatUsdMicrosString } from "@/lib/format-usd-micros";
import type { SignedTicketRequestRow } from "@/lib/openmeter/signed-ticket-events";

type RequestsResponse = {
  items: SignedTicketRequestRow[];
  nextCursor: string | null;
  openMeterConfigured: boolean;
  error?: string;
};

type HistoryScope = "own" | "all";

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
  empty: string;
} {
  if (scope === "all") {
    return {
      title: "Signed ticket requests",
      subtitle:
        "Platform-wide signed ticket requests, newest first. Filtered by the application selector when a subset is selected.",
      empty: "No signed ticket requests for the selected apps in this billing cycle.",
    };
  }
  return {
    title: "Your signed ticket requests",
    subtitle: "Only requests billed to your usage identity, newest first.",
    empty: "No signed ticket requests for your usage identity in this billing cycle.",
  };
}

function RequestRow({ row }: Readonly<{ row: SignedTicketRequestRow }>) {
  const feeLabel = formatUsdMicrosString(row.networkFeeUsdMicros, 4) ?? "$0";
  const pipelineLabel =
    row.modelId && row.modelId !== "unknown"
      ? `${row.pipeline} / ${row.modelId}`
      : row.pipeline;
  return (
    <tr className="border-b border-zinc-800/60 last:border-0">
      <td className="px-2 py-3 text-zinc-300 whitespace-nowrap align-top">
        {formatRequestTime(row.time)}
      </td>
      <td className="px-2 py-3 text-zinc-300 align-top">
        <div className="truncate max-w-[10rem]" title={row.appName || row.clientId}>
          {row.appName || row.clientId}
        </div>
      </td>
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
        title={feeLabel}
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
}: Readonly<{
  items: SignedTicketRequestRow[];
  nextCursor: string | null;
  loadingMore: boolean;
  onLoadMore: () => void;
}>) {
  return (
    <>
      <div className="overflow-x-auto -mx-1">
        <table className="w-full min-w-[640px] text-left text-sm">
          <thead>
            <tr className="border-b border-zinc-800 text-xs uppercase tracking-wider text-zinc-500">
              <th className="px-2 py-2 font-medium">Time</th>
              <th className="px-2 py-2 font-medium">App</th>
              <th className="px-2 py-2 font-medium">Request ID</th>
              <th className="px-2 py-2 font-medium">Pipeline / Model</th>
              <th className="px-2 py-2 font-medium text-right">Network fee</th>
            </tr>
          </thead>
          <tbody>
            {items.map((row) => (
              <RequestRow key={row.eventId} row={row} />
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

function HistoryContent({
  openMeterConfigured,
  loading,
  error,
  items,
  emptyCopy,
  nextCursor,
  loadingMore,
  onLoadMore,
}: Readonly<{
  openMeterConfigured: boolean;
  loading: boolean;
  error: string | null;
  items: SignedTicketRequestRow[];
  emptyCopy: string;
  nextCursor: string | null;
  loadingMore: boolean;
  onLoadMore: () => void;
}>) {
  if (!openMeterConfigured) {
    return (
      <p className="text-sm text-zinc-500 py-6 text-center">
        OpenMeter is not configured, so per-request history is unavailable.
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
  if (items.length === 0) {
    return <p className="text-sm text-zinc-500 py-6 text-center">{emptyCopy}</p>;
  }
  return (
    <RequestTable
      items={items}
      nextCursor={nextCursor}
      loadingMore={loadingMore}
      onLoadMore={onLoadMore}
    />
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
  const [items, setItems] = useState<SignedTicketRequestRow[]>([]);
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
    async (cursor: string | null, append: boolean) => {
      const params = new URLSearchParams();
      params.set("limit", "25");
      params.set("scope", historyScope);
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
      const body = (await res.json().catch(() => null)) as RequestsResponse | null;
      if (!res.ok) {
        throw new Error(body?.error || `Request failed (${res.status})`);
      }
      if (!body) {
        throw new Error("Empty response");
      }

      setOpenMeterConfigured(body.openMeterConfigured !== false);
      setNextCursor(body.nextCursor);
      setItems((prev) => (append ? [...prev, ...body.items] : body.items));
    },
    [resolvedClientIds, historyScope],
  );

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    setItems([]);
    setNextCursor(null);

    fetchPage(null, false)
      .catch((err: unknown) => {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : "Failed to load requests");
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
  }, [fetchPage, clientIdsKey, historyScope]);

  async function onLoadMore() {
    if (!nextCursor || loadingMore) {
      return;
    }
    setLoadingMore(true);
    setError(null);
    try {
      await fetchPage(nextCursor, true);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Failed to load more");
    } finally {
      setLoadingMore(false);
    }
  }

  return (
    <section className="rounded-xl border border-zinc-800 bg-zinc-900/30 p-4 sm:p-5">
      <div className="mb-4">
        <h2 className="text-sm font-semibold text-zinc-200">{copy.title}</h2>
        <p className="text-xs text-zinc-500 mt-1">{copy.subtitle}</p>
      </div>

      <HistoryContent
        openMeterConfigured={openMeterConfigured}
        loading={loading}
        error={error}
        items={items}
        emptyCopy={copy.empty}
        nextCursor={nextCursor}
        loadingMore={loadingMore}
        onLoadMore={() => void onLoadMore()}
      />
    </section>
  );
}
