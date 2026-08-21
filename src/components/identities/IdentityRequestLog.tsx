"use client";

import { useCallback, useEffect, useState } from "react";

import { RequestTable } from "@/components/SignedTicketRequestHistory";
import type { SignedTicketRequestRow } from "@/lib/openmeter/signed-ticket-events";

type RequestsResponse = {
  items: SignedTicketRequestRow[];
  nextCursor: string | null;
  openMeterConfigured: boolean;
  error?: string;
};

/**
 * Request log for a single identity, backed by the app-scoped identity endpoint
 * (authorized by app ownership). Reuses the shared `RequestTable` rendering —
 * `compact` drops the App column and the identity column is redundant here.
 */
export default function IdentityRequestLog({
  appId,
  externalUserId,
}: Readonly<{ appId: string; externalUserId: string }>) {
  const [items, setItems] = useState<SignedTicketRequestRow[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [openMeterConfigured, setOpenMeterConfigured] = useState(true);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const endpoint = `/api/v1/apps/${encodeURIComponent(appId)}/identities/${encodeURIComponent(externalUserId)}/requests`;

  const fetchPage = useCallback(
    async (cursor: string | null): Promise<RequestsResponse> => {
      const params = new URLSearchParams();
      params.set("limit", "25");
      if (cursor) params.set("cursor", cursor);

      const res = await fetch(`${endpoint}?${params.toString()}`, {
        method: "GET",
        credentials: "same-origin",
      });
      const body = (await res.json().catch(() => null)) as RequestsResponse | null;
      if (!res.ok) {
        throw new Error(body?.error || `Request failed (${res.status})`);
      }
      return (
        body ?? { items: [], nextCursor: null, openMeterConfigured: true }
      );
    },
    [endpoint],
  );

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);

    void (async () => {
      try {
        const page = await fetchPage(null);
        if (cancelled) return;
        setItems(page.items);
        setNextCursor(page.nextCursor);
        setOpenMeterConfigured(page.openMeterConfigured);
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : "Failed to load requests");
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [fetchPage]);

  async function onLoadMore() {
    if (!nextCursor || loadingMore) return;
    setLoadingMore(true);
    setError(null);
    try {
      const page = await fetchPage(nextCursor);
      setItems((prev) => [...prev, ...page.items]);
      setNextCursor(page.nextCursor);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load more");
    } finally {
      setLoadingMore(false);
    }
  }

  return (
    <section className="rounded-xl border border-zinc-800 bg-zinc-900/30 p-4 sm:p-5">
      <h2 className="text-sm font-semibold text-zinc-200">Requests</h2>
      <p className="mt-1 text-xs text-zinc-500">
        Signed ticket requests billed to this identity, newest first.
      </p>

      <div className="mt-4">
        {!openMeterConfigured ? (
          <p className="py-6 text-center text-sm text-zinc-500">
            Usage metering is not configured, so per-request history is unavailable.
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
          <p className="py-4 text-center text-sm text-rose-400">{error}</p>
        ) : null}
        {openMeterConfigured && !loading && !error && items.length === 0 ? (
          <p className="py-6 text-center text-sm text-zinc-500">
            No requests for this identity in the current cycle.
          </p>
        ) : null}
        {openMeterConfigured && !loading && !error && items.length > 0 ? (
          <RequestTable
            items={items}
            nextCursor={nextCursor}
            loadingMore={loadingMore}
            onLoadMore={() => void onLoadMore()}
            compact
          />
        ) : null}
      </div>
    </section>
  );
}
