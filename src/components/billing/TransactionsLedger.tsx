"use client";

import { useMemo, useState } from "react";

import {
  filterLedgerEntries,
  type LedgerEntry,
  type LedgerEntryType,
} from "@/lib/billing/transactions-ledger";
import { formatBillingUtcDate } from "@/lib/billing-format";
import {
  formatUsdMicrosExactTitle,
  formatUsdMicrosSummary,
} from "@/lib/format-usd-micros";

const PAGE_SIZE = 25;

const TYPE_FILTERS: Array<{ key: LedgerEntryType | "all"; label: string }> = [
  { key: "all", label: "All" },
  { key: "credit_purchased", label: "Credits" },
  { key: "usage", label: "Usage" },
  { key: "invoice", label: "Invoices" },
  { key: "refund", label: "Refunds" },
];

function typeBadgeClass(type: LedgerEntryType): string {
  if (type === "credit_purchased") return "bg-emerald-500/15 text-emerald-400";
  if (type === "usage") return "bg-blue-500/15 text-blue-300";
  if (type === "refund") return "bg-purple-500/15 text-purple-300";
  return "bg-zinc-700/40 text-zinc-300";
}

function typeLabel(type: LedgerEntryType): string {
  if (type === "credit_purchased") return "credit";
  if (type === "usage") return "usage";
  if (type === "refund") return "refund";
  return "invoice";
}

/** Absolute UTC instant rendered with a fixed locale for SSR hydration. */
function formatEntryDate(iso: string): string {
  return formatBillingUtcDate(iso, { year: "numeric" });
}

function DeltaCell({ entry }: Readonly<{ entry: LedgerEntry }>) {
  const delta = BigInt(entry.creditDeltaUsdMicros || "0");
  if (delta === 0n) {
    return <span className="text-zinc-600">—</span>;
  }
  const positive = delta > 0n;
  return (
    <span
      className={positive ? "text-emerald-400" : "text-zinc-300"}
      title={formatUsdMicrosExactTitle(entry.creditDeltaUsdMicros)}
    >
      {positive ? "+" : "−"}
      {formatUsdMicrosSummary((positive ? delta : -delta).toString())}
    </span>
  );
}

/** Open Stripe hosted invoice via the on-demand API (metadata has no signed URL). */
function LedgerInvoiceDescription({ entry }: Readonly<{ entry: LedgerEntry }>) {
  const [loading, setLoading] = useState(false);

  if (entry.hostedInvoiceUrl) {
    return (
      <a
        href={entry.hostedInvoiceUrl}
        target="_blank"
        rel="noopener noreferrer"
        className="text-emerald-400 transition-colors hover:text-emerald-300"
      >
        {entry.description}
      </a>
    );
  }

  if (!entry.invoiceId) {
    return <>{entry.description}</>;
  }

  async function openHostedInvoice() {
    if (!entry.invoiceId || loading) return;
    setLoading(true);
    try {
      const res = await fetch(
        `/api/v1/billing/invoices/${encodeURIComponent(entry.invoiceId)}/hosted-url`,
        { credentials: "same-origin" },
      );
      const body = (await res.json().catch(() => null)) as {
        hostedInvoiceUrl?: string | null;
        invoicePdf?: string | null;
      } | null;
      const url = body?.hostedInvoiceUrl || body?.invoicePdf;
      if (!res.ok || !url) return;
      globalThis.open(url, "_blank", "noopener,noreferrer");
    } finally {
      setLoading(false);
    }
  }

  return (
    <button
      type="button"
      onClick={() => void openHostedInvoice()}
      disabled={loading}
      className="text-left text-emerald-400 transition-colors hover:text-emerald-300 disabled:opacity-60"
    >
      {loading ? "Opening…" : entry.description}
    </button>
  );
}

/**
 * Chronological credit, usage, invoice and refund history with a running
 * prepaid balance. Usage rows are derived from meter data (OpenMeter exposes
 * no per-event consumption feed) and are marked as such.
 */
export default function TransactionsLedger({
  entries,
}: Readonly<{ entries: LedgerEntry[] }>) {
  const [typeFilter, setTypeFilter] = useState<LedgerEntryType | "all">("all");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [visible, setVisible] = useState(PAGE_SIZE);

  const filtered = useMemo(
    () =>
      filterLedgerEntries(entries, {
        types: typeFilter === "all" ? undefined : [typeFilter],
        // Extend `to` to end-of-day so the chosen date is inclusive.
        from: from || null,
        to: to ? `${to}T23:59:59.999Z` : null,
      }),
    [entries, typeFilter, from, to],
  );

  const page = filtered.slice(0, visible);
  const hasDerived = filtered.some((entry) => entry.derived);

  return (
    <section>
      <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-sm font-semibold text-zinc-200">Transactions</h2>
        <div className="flex flex-wrap items-center gap-2">
          <div className="inline-flex rounded-lg border border-zinc-700 p-0.5">
            {TYPE_FILTERS.map((filter) => (
              <button
                key={filter.key}
                type="button"
                onClick={() => {
                  setTypeFilter(filter.key);
                  setVisible(PAGE_SIZE);
                }}
                aria-pressed={typeFilter === filter.key}
                className={`rounded-md px-2.5 py-1 text-xs font-semibold transition-colors ${
                  typeFilter === filter.key
                    ? "bg-zinc-700 text-zinc-100"
                    : "text-zinc-400 hover:text-zinc-200"
                }`}
              >
                {filter.label}
              </button>
            ))}
          </div>
          <label className="flex items-center gap-1 text-xs text-zinc-500">
            <span className="sr-only">From date</span>
            <input
              type="date"
              value={from}
              onChange={(e) => {
                setFrom(e.target.value);
                setVisible(PAGE_SIZE);
              }}
              className="rounded-md border border-zinc-700 bg-black/20 px-2 py-1 text-xs text-zinc-300"
            />
          </label>
          <label className="flex items-center gap-1 text-xs text-zinc-500">
            <span className="sr-only">To date</span>
            <input
              type="date"
              value={to}
              onChange={(e) => {
                setTo(e.target.value);
                setVisible(PAGE_SIZE);
              }}
              className="rounded-md border border-zinc-700 bg-black/20 px-2 py-1 text-xs text-zinc-300"
            />
          </label>
        </div>
      </div>

      {filtered.length === 0 ? (
        <div className="rounded-xl border border-white/[0.06] bg-white/[0.02] px-4 py-5 text-sm text-zinc-500">
          {entries.length === 0
            ? "No billing activity yet. Credit purchases, usage and invoices will appear here."
            : "No transactions match these filters."}
        </div>
      ) : (
        <div className="overflow-x-auto rounded-xl border border-white/[0.06] bg-white/[0.02]">
          <table className="w-full min-w-[44rem] text-sm">
            <thead>
              <tr className="border-b border-white/[0.06] text-xs uppercase tracking-wider text-zinc-500">
                <th className="px-4 py-3 text-left font-medium">Date</th>
                <th className="px-4 py-3 text-left font-medium">Type</th>
                <th className="px-4 py-3 text-left font-medium">Description</th>
                <th className="px-4 py-3 text-right font-medium">Amount</th>
                <th className="px-4 py-3 text-right font-medium">Credit change</th>
                <th className="px-4 py-3 text-right font-medium">Balance</th>
              </tr>
            </thead>
            <tbody>
              {page.map((entry) => (
                <tr
                  key={entry.id}
                  className="border-b border-white/[0.04] last:border-b-0 hover:bg-white/[0.02]"
                >
                  <td className="whitespace-nowrap px-4 py-3 text-zinc-300">
                    {formatEntryDate(entry.date)}
                  </td>
                  <td className="px-4 py-3">
                    <span
                      className={`rounded px-1.5 py-0.5 text-[10px] uppercase tracking-wider ${typeBadgeClass(entry.type)}`}
                    >
                      {typeLabel(entry.type)}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-zinc-400">
                    <LedgerInvoiceDescription entry={entry} />
                    {entry.derived ? (
                      <span
                        className="ml-1.5 text-[10px] text-zinc-600"
                        title="Derived from metered usage — the billing engine reports a consumed total, not per-event credit consumption."
                      >
                        (derived)
                      </span>
                    ) : null}
                    {entry.status ? (
                      <span className="ml-1.5 text-[10px] uppercase tracking-wide text-zinc-600">
                        {entry.status}
                      </span>
                    ) : null}
                  </td>
                  <td
                    className="px-4 py-3 text-right font-mono tabular-nums text-zinc-200"
                    title={formatUsdMicrosExactTitle(entry.amountUsdMicros)}
                  >
                    {formatUsdMicrosSummary(entry.amountUsdMicros)}
                  </td>
                  <td className="px-4 py-3 text-right font-mono tabular-nums">
                    <DeltaCell entry={entry} />
                  </td>
                  <td
                    className="px-4 py-3 text-right font-mono tabular-nums text-zinc-400"
                    title={
                      entry.balanceUsdMicros === null
                        ? "Balance unavailable — some billing history could not be loaded."
                        : formatUsdMicrosExactTitle(entry.balanceUsdMicros)
                    }
                  >
                    {entry.balanceUsdMicros === null ? (
                      <span className="text-zinc-600">—</span>
                    ) : (
                      formatUsdMicrosSummary(entry.balanceUsdMicros)
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>

          {filtered.length > visible ? (
            <div className="flex justify-center border-t border-white/[0.06] p-3">
              <button
                type="button"
                onClick={() => setVisible((n) => n + PAGE_SIZE)}
                className="rounded-lg bg-zinc-800 px-4 py-2 text-xs font-semibold text-zinc-200 transition-colors hover:bg-zinc-700"
              >
                Show more ({filtered.length - visible} remaining)
              </button>
            </div>
          ) : null}
        </div>
      )}

      {hasDerived ? (
        <p className="mt-2 text-[11px] text-zinc-600">
          Usage rows are derived from metered spend for the current cycle and settle
          against the plan allowance before prepaid credits.
        </p>
      ) : null}
    </section>
  );
}
