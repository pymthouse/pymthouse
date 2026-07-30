"use client";

import { useEffect, useState } from "react";
import Link from "next/link";

import type { AppCustomersListPayload } from "@/lib/app-customers";
import { formatUsdMicrosString } from "@/lib/format-usd-micros";

type LoadState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; data: AppCustomersListPayload };

function statusClass(status: string): string {
  if (status === "active") {
    return "border-emerald-500/20 bg-emerald-500/10 text-emerald-400";
  }
  if (status === "inactive") {
    return "border-zinc-600/40 bg-zinc-800/60 text-zinc-400";
  }
  return "border-amber-500/20 bg-amber-500/10 text-amber-300";
}

export default function AppCustomersPanel({
  appId,
}: Readonly<{ appId: string }>) {
  const [state, setState] = useState<LoadState>({ status: "loading" });
  const [retryToken, setRetryToken] = useState(0);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      setState({ status: "loading" });
      try {
        const res = await fetch(
          `/api/v1/apps/${encodeURIComponent(appId)}/customers`,
        );
        if (res.status === 401) {
          throw new Error("Please sign in to view app users.");
        }
        if (res.status === 403 || res.status === 404) {
          throw new Error("App users not found.");
        }
        if (!res.ok) {
          throw new Error("Could not load app users.");
        }
        const data = (await res.json()) as AppCustomersListPayload;
        if (!cancelled) {
          setState({ status: "ready", data });
        }
      } catch (err) {
        if (!cancelled) {
          setState({
            status: "error",
            message: err instanceof Error ? err.message : "Could not load app users.",
          });
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [appId, retryToken]);

  if (state.status === "loading") {
    return (
      <div className="rounded-xl border border-zinc-800 bg-zinc-900/30 p-5 animate-pulse">
        <div className="h-3 w-40 rounded bg-zinc-800 mb-4" />
        <div className="h-32 rounded bg-zinc-800/60" />
      </div>
    );
  }

  if (state.status === "error") {
    return (
      <div className="text-center py-12">
        <h2 className="text-lg font-medium text-zinc-300">Users unavailable</h2>
        <p className="text-zinc-500 mt-2">{state.message}</p>
        <button
          type="button"
          onClick={() => setRetryToken((n) => n + 1)}
          className="mt-4 text-sm text-emerald-400 hover:text-emerald-300"
        >
          Retry
        </button>
      </div>
    );
  }

  const { data } = state;
  const cycleLabel = `${data.cycle.start.slice(0, 10)} → ${data.cycle.end.slice(0, 10)}`;

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-xl sm:text-2xl font-bold text-zinc-100">All Users</h1>
        <p className="text-xs sm:text-sm text-zinc-500 mt-1">
          Provisioned users for {data.appName}. Cycle usage {cycleLabel}.
        </p>
        {data.balancesTruncated ? (
          <p className="mt-2 text-xs text-amber-400/90">
            Spendable and subscription details are shown for the top{" "}
            {data.customers.filter((c) => c.spendableUsdMicros != null).length}{" "}
            users by cycle spend.
          </p>
        ) : null}
      </div>

      {data.customers.length === 0 ? (
        <div className="rounded-xl border border-zinc-800 bg-zinc-900/30 p-6 text-center">
          <p className="text-zinc-300 font-medium">No provisioned users</p>
          <p className="text-zinc-500 text-sm mt-1">
            Users appear here after Builder provisioning or first mint.
          </p>
        </div>
      ) : (
        <div className="overflow-x-auto rounded-xl border border-zinc-800 bg-zinc-900/30">
          <table className="w-full min-w-[720px] text-left text-sm">
            <thead>
              <tr className="border-b border-zinc-800 text-[11px] uppercase tracking-wide text-zinc-500">
                <th className="px-4 py-3 font-medium">User</th>
                <th className="px-4 py-3 font-medium">Status</th>
                <th className="px-4 py-3 font-medium text-right">Requests</th>
                <th className="px-4 py-3 font-medium text-right">Cycle spend</th>
                <th className="px-4 py-3 font-medium text-right">Spendable</th>
                <th className="px-4 py-3 font-medium">Plan</th>
              </tr>
            </thead>
            <tbody>
              {data.customers.map((row) => {
                const href = `/apps/${encodeURIComponent(appId)}/users/${encodeURIComponent(row.externalUserId)}`;
                return (
                  <tr
                    key={row.id}
                    className="border-b border-zinc-800/80 last:border-0 hover:bg-white/[0.02]"
                  >
                    <td className="px-4 py-3">
                      <Link
                        href={href}
                        className="block min-w-0 hover:text-emerald-300 transition-colors"
                      >
                        <span className="font-medium text-zinc-100 truncate block max-w-[220px]">
                          {row.email?.trim() || row.externalUserId}
                        </span>
                        {row.email?.trim() ? (
                          <span className="font-mono text-[11px] text-zinc-500 truncate block max-w-[220px]">
                            {row.externalUserId}
                          </span>
                        ) : null}
                        {row.isOwnerWallet ? (
                          <span className="mt-1 inline-block rounded border border-sky-500/20 bg-sky-500/10 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-sky-300">
                            Owner wallet
                          </span>
                        ) : null}
                      </Link>
                    </td>
                    <td className="px-4 py-3">
                      <span
                        className={`inline-block rounded border px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide ${statusClass(row.status)}`}
                      >
                        {row.status}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-right font-mono tabular-nums text-zinc-300">
                      {row.requestCount.toLocaleString()}
                    </td>
                    <td className="px-4 py-3 text-right font-mono tabular-nums text-zinc-300">
                      {formatUsdMicrosString(row.networkFeeUsdMicros, 4) ?? "$0"}
                    </td>
                    <td className="px-4 py-3 text-right font-mono tabular-nums text-zinc-300">
                      {formatUsdMicrosString(row.spendableUsdMicros ?? undefined, 4) ??
                        "—"}
                    </td>
                    <td className="px-4 py-3 text-zinc-400">
                      {row.subscription ? (
                        <span>
                          <span className="text-zinc-200">
                            {row.subscription.planName ?? "Plan"}
                          </span>
                          <span className="ml-1.5 text-[10px] uppercase text-zinc-500">
                            {row.subscription.status}
                          </span>
                        </span>
                      ) : (
                        "—"
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
