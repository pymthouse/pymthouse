"use client";

import { useMemo, useState } from "react";

import { formatInvoicePeriodLabel } from "@/lib/billing/transactions-ledger";
import { formatBillingUtcDate } from "@/lib/billing-format";
import { formatUsdMicrosSummary } from "@/lib/format-usd-micros";
import type { TenantInvoiceDto } from "@/lib/openmeter/invoices";

const PAGE_SIZE = 10;

/** Decimal dollar string ("5.00") → USD micros, for consistent money formatting. */
function decimalDollarsToMicros(raw: string | null | undefined): string {
  const trimmed = raw?.trim();
  if (!trimmed) return "0";
  const match = /^(-?)(\d*)(?:\.(\d*))?$/.exec(trimmed);
  if (!match) return "0";
  const [, sign, wholePart = "", fracPart = ""] = match;
  try {
    const total =
      BigInt(wholePart || "0") * 1_000_000n +
      BigInt((fracPart + "000000").slice(0, 6));
    return (sign === "-" ? -total : total).toString();
  } catch {
    return "0";
  }
}

function isZeroInvoice(invoice: TenantInvoiceDto): boolean {
  return decimalDollarsToMicros(invoice.totalAmount) === "0";
}

/**
 * Human label for an invoice, e.g. `Usage overage · Jul 2026`.
 * Internal identifiers (`OM-SANDBOX-APP_-1`) never surface as the label —
 * they stay available in the details row.
 */
export function invoiceDisplayLabel(invoice: TenantInvoiceDto): string {
  const period = formatInvoicePeriodLabel(invoice.periodStart, invoice.periodEnd);
  const base = isZeroInvoice(invoice) ? "No charges" : "Usage overage";
  return period ? `${base} · ${period}` : base;
}

/** Period covered, e.g. `Jul 1 – Jul 31, 2026`. */
function formatPeriodRange(invoice: TenantInvoiceDto): string {
  const { periodStart, periodEnd } = invoice;
  if (!periodStart && !periodEnd) return "—";
  const startLabel =
    periodStart && !Number.isNaN(Date.parse(periodStart))
      ? formatBillingUtcDate(periodStart)
      : null;
  const endLabel =
    periodEnd && !Number.isNaN(Date.parse(periodEnd))
      ? formatBillingUtcDate(periodEnd, { year: "numeric" })
      : null;
  if (startLabel && endLabel) return `${startLabel} – ${endLabel}`;
  return endLabel ?? startLabel ?? "—";
}

function formatIssuedAt(iso: string | undefined): string {
  if (!iso || Number.isNaN(Date.parse(iso))) return "—";
  return formatBillingUtcDate(iso, { year: "numeric" });
}

function statusBadgeClass(status: string): string {
  const normalized = status.toLowerCase();
  if (normalized.includes("paid")) return "bg-emerald-500/15 text-emerald-400";
  if (normalized.includes("void") || normalized.includes("uncollectible")) {
    return "bg-red-500/15 text-red-400";
  }
  if (normalized.includes("draft") || normalized.includes("gathering")) {
    return "bg-zinc-700/40 text-zinc-400";
  }
  return "bg-blue-500/15 text-blue-300";
}

function InvoiceLink({ invoice }: Readonly<{ invoice: TenantInvoiceDto }>) {
  const [state, setState] = useState<"idle" | "loading" | "error">("idle");
  const [error, setError] = useState<string | null>(null);

  if (!invoice.externalInvoicingId) {
    return <span className="text-xs text-zinc-600">—</span>;
  }

  async function openInvoice() {
    setState("loading");
    setError(null);
    try {
      const res = await fetch(
        `/api/v1/billing/invoices/${encodeURIComponent(invoice.id)}/hosted-url`,
        { credentials: "same-origin" },
      );
      const body = (await res.json().catch(() => null)) as {
        hostedInvoiceUrl?: string | null;
        invoicePdf?: string | null;
        error?: string;
      } | null;
      if (!res.ok) {
        throw new Error(body?.error || "Invoice link unavailable");
      }
      const url = body?.hostedInvoiceUrl || body?.invoicePdf;
      if (!url) {
        throw new Error("No hosted invoice available");
      }
      globalThis.open(url, "_blank", "noopener,noreferrer");
      setState("idle");
    } catch (err) {
      setState("error");
      setError(err instanceof Error ? err.message : "Invoice link unavailable");
    }
  }

  return (
    <div className="flex flex-col items-end">
      <button
        type="button"
        onClick={() => void openInvoice()}
        disabled={state === "loading"}
        className="text-xs text-emerald-400 transition-colors hover:text-emerald-300 disabled:opacity-50"
      >
        {state === "loading" ? "Opening…" : "View invoice →"}
      </button>
      {state === "error" && error ? (
        <span className="mt-0.5 text-[10px] text-rose-400">{error}</span>
      ) : null}
    </div>
  );
}

/**
 * Platform (PymtHouse → developer) invoices. Zero-value invoices are hidden by
 * default because a settled cycle emits one per period and they crowd out the
 * rows that actually carry a charge.
 */
export default function PlatformInvoicesTable({
  invoices,
}: Readonly<{ invoices: TenantInvoiceDto[] }>) {
  const [showZero, setShowZero] = useState(false);
  const [visible, setVisible] = useState(PAGE_SIZE);
  const [expanded, setExpanded] = useState<string | null>(null);

  const zeroCount = useMemo(
    () => invoices.filter((invoice) => isZeroInvoice(invoice)).length,
    [invoices],
  );
  const filtered = useMemo(
    () => (showZero ? invoices : invoices.filter((inv) => !isZeroInvoice(inv))),
    [invoices, showZero],
  );
  const page = filtered.slice(0, visible);

  if (invoices.length === 0) {
    return (
      <div className="rounded-xl border border-white/[0.06] bg-white/[0.02] px-4 py-5 text-sm text-zinc-500">
        No platform invoices yet.
      </div>
    );
  }

  return (
    <>
      {zeroCount > 0 ? (
        <label className="mb-3 flex items-center gap-2 text-xs text-zinc-500">
          <input
            type="checkbox"
            checked={showZero}
            onChange={(e) => {
              setShowZero(e.target.checked);
              setVisible(PAGE_SIZE);
            }}
            className="h-3.5 w-3.5 rounded border-zinc-700 bg-black/20"
          />
          Show $0 invoices ({zeroCount})
        </label>
      ) : null}

      {filtered.length === 0 ? (
        <div className="rounded-xl border border-white/[0.06] bg-white/[0.02] px-4 py-5 text-sm text-zinc-500">
          No invoices with charges yet.
        </div>
      ) : (
        <div className="overflow-x-auto rounded-xl border border-white/[0.06] bg-white/[0.02]">
          <table className="w-full min-w-[46rem] text-sm">
            <thead>
              <tr className="border-b border-white/[0.06] text-xs uppercase tracking-wider text-zinc-500">
                <th className="px-4 py-3 text-left font-medium">Invoice</th>
                <th className="px-4 py-3 text-left font-medium">Issued</th>
                <th className="px-4 py-3 text-left font-medium">Period covered</th>
                <th className="px-4 py-3 text-right font-medium">Amount</th>
                <th className="px-4 py-3 text-left font-medium">Status</th>
                <th className="px-4 py-3 text-right font-medium">Link</th>
              </tr>
            </thead>
            <tbody>
              {page.map((invoice) => {
                const micros = decimalDollarsToMicros(invoice.totalAmount);
                const isOpen = expanded === invoice.id;
                return [
                  <tr
                    key={invoice.id}
                    className="border-b border-white/[0.04] hover:bg-white/[0.02]"
                  >
                    <td className="px-4 py-3">
                      <button
                        type="button"
                        onClick={() => setExpanded(isOpen ? null : invoice.id)}
                        aria-expanded={isOpen}
                        className="text-left text-zinc-200 transition-colors hover:text-emerald-400"
                      >
                        {invoiceDisplayLabel(invoice)}
                      </button>
                    </td>
                    <td className="whitespace-nowrap px-4 py-3 text-zinc-400">
                      {formatIssuedAt(invoice.issuedAt)}
                    </td>
                    <td className="whitespace-nowrap px-4 py-3 text-zinc-400">
                      {formatPeriodRange(invoice)}
                    </td>
                    <td className="px-4 py-3 text-right font-mono tabular-nums text-zinc-100">
                      {formatUsdMicrosSummary(micros)}
                    </td>
                    <td className="px-4 py-3">
                      <span
                        className={`rounded px-1.5 py-0.5 text-[10px] uppercase tracking-wider ${statusBadgeClass(invoice.status)}`}
                      >
                        {invoice.status}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-right">
                      <InvoiceLink invoice={invoice} />
                    </td>
                  </tr>,
                  isOpen ? (
                    <tr key={`${invoice.id}:details`} className="bg-black/20">
                      <td colSpan={6} className="px-4 py-3">
                        <dl className="grid grid-cols-1 gap-x-6 gap-y-1 text-xs sm:grid-cols-2">
                          <div className="flex gap-2">
                            <dt className="text-zinc-500">Invoice ID</dt>
                            <dd className="break-all font-mono text-zinc-400">
                              {invoice.id}
                            </dd>
                          </div>
                          {invoice.number ? (
                            <div className="flex gap-2">
                              <dt className="text-zinc-500">Number</dt>
                              <dd className="break-all font-mono text-zinc-400">
                                {invoice.number}
                              </dd>
                            </div>
                          ) : null}
                          {invoice.externalInvoicingId ? (
                            <div className="flex gap-2">
                              <dt className="text-zinc-500">Stripe invoice</dt>
                              <dd className="break-all font-mono text-zinc-400">
                                {invoice.externalInvoicingId}
                              </dd>
                            </div>
                          ) : null}
                          <div className="flex gap-2">
                            <dt className="text-zinc-500">Currency</dt>
                            <dd className="font-mono text-zinc-400">
                              {invoice.currency}
                            </dd>
                          </div>
                        </dl>
                      </td>
                    </tr>
                  ) : null,
                ];
              })}
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
    </>
  );
}
