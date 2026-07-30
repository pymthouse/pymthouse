"use client";

import { useEffect, useState } from "react";
import Link from "next/link";

import AllowanceProgressBar from "@/components/AllowanceProgressBar";
import type { AppCustomerDetailPayload } from "@/lib/app-customers";
import { formatUsdMicrosString } from "@/lib/format-usd-micros";

type LoadState =
  | { status: "loading" }
  | { status: "error"; message: string; code?: number }
  | { status: "ready"; data: AppCustomerDetailPayload };

function statusClass(status: string): string {
  if (status === "active") {
    return "border-emerald-500/20 bg-emerald-500/10 text-emerald-400";
  }
  if (status === "inactive") {
    return "border-zinc-600/40 bg-zinc-800/60 text-zinc-400";
  }
  return "border-amber-500/20 bg-amber-500/10 text-amber-300";
}

export default function AppCustomerDetailView({
  appId,
  externalUserId,
}: Readonly<{
  appId: string;
  externalUserId: string;
}>) {
  const [state, setState] = useState<LoadState>({ status: "loading" });
  const [retryToken, setRetryToken] = useState(0);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      setState({ status: "loading" });
      try {
        const res = await fetch(
          `/api/v1/apps/${encodeURIComponent(appId)}/customers/${encodeURIComponent(externalUserId)}`,
        );
        if (res.status === 401) {
          throw Object.assign(new Error("Please sign in to view this user."), {
            code: 401,
          });
        }
        if (res.status === 404) {
          throw Object.assign(new Error("User not found for this app."), {
            code: 404,
          });
        }
        if (!res.ok) {
          throw Object.assign(new Error("Could not load user detail."), {
            code: res.status,
          });
        }
        const data = (await res.json()) as AppCustomerDetailPayload;
        if (!cancelled) {
          setState({ status: "ready", data });
        }
      } catch (err) {
        if (!cancelled) {
          const e = err as Error & { code?: number };
          setState({
            status: "error",
            message: e.message || "Could not load user detail.",
            code: e.code,
          });
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [appId, externalUserId, retryToken]);

  if (state.status === "loading") {
    return (
      <div className="space-y-4 animate-pulse">
        <div className="h-6 w-48 rounded bg-zinc-800" />
        <div className="h-40 rounded-xl bg-zinc-800/60" />
        <div className="h-40 rounded-xl bg-zinc-800/60" />
      </div>
    );
  }

  if (state.status === "error") {
    return (
      <div className="text-center py-12">
        <h2 className="text-lg font-medium text-zinc-300">User unavailable</h2>
        <p className="text-zinc-500 mt-2">{state.message}</p>
        <div className="mt-4 flex items-center justify-center gap-4">
          <Link
            href={`/apps/${encodeURIComponent(appId)}/usage/users`}
            className="text-sm text-zinc-400 hover:text-zinc-200"
          >
            ← All Users
          </Link>
          {state.code !== 401 && state.code !== 404 ? (
            <button
              type="button"
              onClick={() => setRetryToken((n) => n + 1)}
              className="text-sm text-emerald-400 hover:text-emerald-300"
            >
              Retry
            </button>
          ) : null}
        </div>
      </div>
    );
  }

  const { data } = state;
  const { customer, balance, subscription, usage, cycle } = data;
  const displayName = customer.email?.trim() || customer.externalUserId;
  const hasPlanAllowance =
    balance.planGrantedUsdMicros != null &&
    BigInt(balance.planGrantedUsdMicros) > 0n;
  const cycleLabel = `${cycle.start.slice(0, 10)} → ${cycle.end.slice(0, 10)}`;

  return (
    <div className="space-y-6">
      <div>
        <nav className="text-sm text-zinc-500 mb-3" aria-label="Breadcrumb">
          <Link
            href={`/apps/${encodeURIComponent(appId)}/usage/users`}
            className="hover:text-zinc-300 transition-colors"
          >
            All Users
          </Link>
          <span className="mx-1.5 text-zinc-600" aria-hidden>
            /
          </span>
          <span className="text-zinc-200 font-medium" aria-current="page">
            {displayName}
          </span>
        </nav>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h1 className="text-xl sm:text-2xl font-bold text-zinc-100">
              {displayName}
            </h1>
            <p className="mt-1 font-mono text-xs text-zinc-500">
              {customer.externalUserId}
            </p>
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <span
                className={`inline-block rounded border px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide ${statusClass(customer.status)}`}
              >
                {customer.status}
              </span>
              <span className="text-[11px] text-zinc-500">
                role {customer.role}
              </span>
              {customer.isOwnerWallet ? (
                <span className="rounded border border-sky-500/20 bg-sky-500/10 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-sky-300">
                  Owner wallet
                </span>
              ) : null}
            </div>
          </div>
          <p className="text-xs text-zinc-500">Cycle {cycleLabel}</p>
        </div>
      </div>

      <section className="grid gap-4 sm:grid-cols-2">
        <div className="rounded-xl border border-white/[0.06] bg-white/[0.02] p-5">
          <h2 className="text-[10.5px] font-medium uppercase tracking-[0.06em] text-zinc-500">
            Spendable
          </h2>
          <p className="mt-2 font-mono text-2xl tabular-nums text-zinc-100">
            {formatUsdMicrosString(balance.spendableUsdMicros ?? undefined, 4) ??
              "—"}
          </p>
          <p className="mt-1 text-xs text-zinc-500">
            Plan remaining{" "}
            {formatUsdMicrosString(
              balance.planRemainingUsdMicros ?? undefined,
              4,
            ) ?? "—"}
            {balance.hasAccess === false ? (
              <span className="ml-2 text-amber-400">· gate blocked</span>
            ) : null}
          </p>
          {hasPlanAllowance && balance.planGrantedUsdMicros ? (
            <AllowanceProgressBar
              usedUsdMicros={balance.planConsumedUsdMicros ?? "0"}
              allowanceUsdMicros={balance.planGrantedUsdMicros}
              className="mt-4"
            />
          ) : null}
        </div>

        <div className="rounded-xl border border-white/[0.06] bg-white/[0.02] p-5">
          <h2 className="text-[10.5px] font-medium uppercase tracking-[0.06em] text-zinc-500">
            Subscription
          </h2>
          {subscription ? (
            <>
              <p className="mt-2 text-lg font-medium text-zinc-100">
                {subscription.planName ?? "Plan"}
              </p>
              <p className="mt-1 text-xs text-zinc-500">
                <span className="uppercase tracking-wide text-zinc-400">
                  {subscription.status}
                </span>
                {subscription.planType ? (
                  <>
                    {" "}
                    · {subscription.planType}
                  </>
                ) : null}
              </p>
              {subscription.openmeterPlanKey ? (
                <p className="mt-2 font-mono text-[11px] text-zinc-600">
                  {subscription.openmeterPlanKey}
                </p>
              ) : null}
            </>
          ) : (
            <p className="mt-2 text-sm text-zinc-500">No active subscription.</p>
          )}
        </div>
      </section>

      <section className="rounded-xl border border-white/[0.06] bg-white/[0.02] p-5">
        <h2 className="text-sm font-semibold text-zinc-200">This cycle</h2>
        <div className="mt-3 flex flex-wrap gap-6">
          <div>
            <p className="text-[10.5px] uppercase tracking-wide text-zinc-500">
              Network fee
            </p>
            <p className="mt-1 font-mono text-lg tabular-nums text-zinc-100">
              {formatUsdMicrosString(usage.networkFeeUsdMicros, 4) ?? "$0"}
            </p>
          </div>
          <div>
            <p className="text-[10.5px] uppercase tracking-wide text-zinc-500">
              Requests
            </p>
            <p className="mt-1 font-mono text-lg tabular-nums text-zinc-100">
              {usage.requestCount.toLocaleString()}
            </p>
          </div>
        </div>

        {usage.byPipelineModel.length > 0 ? (
          <div className="mt-5 overflow-x-auto">
            <table className="w-full min-w-[420px] text-left text-sm">
              <thead>
                <tr className="border-b border-zinc-800 text-[11px] uppercase tracking-wide text-zinc-500">
                  <th className="py-2 pr-4 font-medium">Pipeline</th>
                  <th className="py-2 pr-4 font-medium">Model</th>
                  <th className="py-2 pr-4 font-medium text-right">Requests</th>
                  <th className="py-2 font-medium text-right">Fee</th>
                </tr>
              </thead>
              <tbody>
                {usage.byPipelineModel.map((row) => (
                  <tr
                    key={`${row.pipeline}|${row.modelId}`}
                    className="border-b border-zinc-800/60 last:border-0"
                  >
                    <td className="py-2 pr-4 text-zinc-300">{row.pipeline}</td>
                    <td className="py-2 pr-4 font-mono text-xs text-zinc-400">
                      {row.modelId}
                    </td>
                    <td className="py-2 pr-4 text-right font-mono tabular-nums text-zinc-300">
                      {row.requestCount.toLocaleString()}
                    </td>
                    <td className="py-2 text-right font-mono tabular-nums text-zinc-300">
                      {formatUsdMicrosString(row.networkFeeUsdMicros, 4) ?? "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="mt-4 text-sm text-zinc-500">No usage in this cycle.</p>
        )}
      </section>

      <p className="text-xs text-zinc-600">
        Created {customer.createdAt.slice(0, 10)} ·{" "}
        <Link
          href={`/apps/${encodeURIComponent(appId)}/usage`}
          className="text-zinc-400 hover:text-zinc-200"
        >
          App usage
        </Link>
      </p>
    </div>
  );
}
