/**
 * Chronological billing ledger for the owner prepaid wallet.
 *
 * OpenMeter exposes dated credit *grants* and invoices, but has no per-event
 * consumption feed — only a scalar consumed total. Consumption is therefore
 * synthesized from the usage meter: daily metered spend is walked against the
 * plan's included allowance, and whatever falls past the allowance is what
 * burned credits that day.
 *
 * Running balances are assigned backward from the live balance, so the last
 * row always equals the prepaid balance shown elsewhere on the page.
 *
 * Client-safe (no DB/Node imports).
 */

import {
  invoiceLineLedgerDescription,
  type InvoiceLineKind,
  type InvoiceLineSummary,
} from "@/lib/billing/invoice-line-labels";

export type LedgerEntryType =
  | "credit_purchased"
  | "usage"
  | "invoice"
  | "refund";

export type LedgerEntry = {
  id: string;
  /** ISO timestamp (or date) this entry occurred. */
  date: string;
  type: LedgerEntryType;
  description: string;
  /** Gross amount, always non-negative (USD micros). */
  amountUsdMicros: string;
  /** Signed change to the prepaid credit balance (USD micros). */
  creditDeltaUsdMicros: string;
  /**
   * Prepaid credit balance after this entry (USD micros).
   *
   * Null when the ledger's inputs were incomplete: the running balance is
   * derived by walking back from the live balance over the entries below it,
   * so a missing grant or usage day makes every earlier figure wrong. Better
   * to show nothing than a confidently incorrect balance.
   */
  balanceUsdMicros: string | null;
  /** True when the row is derived from meter data rather than a billing record. */
  derived: boolean;
  status?: string | null;
  invoiceId?: string | null;
  hostedInvoiceUrl?: string | null;
};

export type LedgerGrantInput = {
  id: string;
  amountUsdMicros: string;
  /** ISO date; entries without one cannot be placed chronologically. */
  date: string | null;
  name?: string | null;
};

export type LedgerDailyUsageInput = {
  /** UTC date key (YYYY-MM-DD). */
  date: string;
  usedUsdMicros: string;
};

export type LedgerInvoiceLineInput = {
  id: string;
  name: string;
  description?: string;
  totalAmountUsdMicros: string;
  kind: InvoiceLineKind;
};

export type LedgerInvoiceInput = {
  id: string;
  number?: string | null;
  status: string;
  totalAmountUsdMicros: string;
  issuedAt?: string | null;
  periodStart?: string | null;
  periodEnd?: string | null;
  hostedInvoiceUrl?: string | null;
  /** OpenMeter `standard` | `credit_note`. */
  invoiceType?: string | null;
  /** Card brand / LINK when the invoice was paid (Connect settlement). */
  paymentMethodBrand?: string | null;
  lines?: LedgerInvoiceLineInput[] | null;
};

function parseMicros(raw: string | null | undefined): bigint {
  if (raw == null) return 0n;
  const trimmed = raw.trim();
  if (!trimmed) return 0n;
  try {
    return BigInt(trimmed);
  } catch {
    return 0n;
  }
}

function minBigInt(a: bigint, b: bigint): bigint {
  return a < b ? a : b;
}

/**
 * Split daily metered spend into the part absorbed by the plan allowance and
 * the part that burned prepaid credits, walking days in chronological order.
 */
export function splitDailyUsageAgainstAllowance(
  dailyUsage: LedgerDailyUsageInput[],
  planIncludedUsdMicros: string | null | undefined,
): Array<{ date: string; usedUsdMicros: bigint; creditBurnUsdMicros: bigint }> {
  const allowance = parseMicros(planIncludedUsdMicros);
  let planConsumed = 0n;

  return [...dailyUsage]
    .sort((a, b) => a.date.localeCompare(b.date))
    .map((day) => {
      const used = parseMicros(day.usedUsdMicros);
      const planRemaining =
        allowance > planConsumed ? allowance - planConsumed : 0n;
      const planPart = minBigInt(used, planRemaining);
      planConsumed += planPart;
      return {
        date: day.date,
        usedUsdMicros: used,
        creditBurnUsdMicros: used - planPart,
      };
    });
}

/** Ledger label for a settlement invoice, including paid-via brand when known. */
export function invoiceDescription(invoice: LedgerInvoiceInput): string {
  const period = formatInvoicePeriodLabel(invoice.periodStart, invoice.periodEnd);
  const base = period ? `Invoice · ${period}` : "Invoice";
  const status = (invoice.status ?? "").trim().toLowerCase();
  if (status !== "paid") {
    if (status === "open" || status === "draft") {
      return `${base} · ${status}`;
    }
    if (status === "pending") {
      // Usage that has accrued but has not yet become a real invoice
      // (see merchant-connect's synthetic "pending_usage" row) — distinct
      // wording from open/draft so it does not read as an invoice already
      // in flight toward collection.
      return period ? `Usage · ${period} · not yet invoiced` : "Usage · not yet invoiced";
    }
    return base;
  }
  const brand = invoice.paymentMethodBrand?.trim();
  if (brand) {
    return `${base} · Paid via ${brand}`;
  }
  return `${base} · Paid`;
}

function toLineSummary(line: LedgerInvoiceLineInput): InvoiceLineSummary {
  return {
    id: line.id,
    name: line.name,
    description: line.description,
    totalAmount: line.totalAmountUsdMicros,
    kind: line.kind,
  };
}

function pushInvoiceDrafts(
  drafts: Array<
    Omit<LedgerEntry, "balanceUsdMicros"> & { creditDelta: bigint }
  >,
  invoice: LedgerInvoiceInput,
): void {
  const date =
    invoice.issuedAt || invoice.periodEnd || invoice.periodStart || "";
  const creditNote = invoice.invoiceType === "credit_note";
  const lines = (invoice.lines ?? []).filter(
    (line) => parseMicros(line.totalAmountUsdMicros) !== 0n,
  );

  if (lines.length > 0) {
    for (const line of lines) {
      const amount = parseMicros(line.totalAmountUsdMicros);
      const isRefund = creditNote || amount < 0n;
      drafts.push({
        id: `invoice:${invoice.id}:line:${line.id}`,
        date,
        type: isRefund ? "refund" : "invoice",
        description: invoiceLineLedgerDescription(toLineSummary(line)),
        amountUsdMicros: (amount < 0n ? -amount : amount).toString(),
        creditDeltaUsdMicros: "0",
        creditDelta: 0n,
        derived: false,
        status: invoice.status,
        invoiceId: invoice.id,
        hostedInvoiceUrl: invoice.hostedInvoiceUrl ?? null,
      });
    }
    return;
  }

  const amount = parseMicros(invoice.totalAmountUsdMicros);
  const isRefund = creditNote || amount < 0n;
  drafts.push({
    id: `invoice:${invoice.id}`,
    date,
    type: isRefund ? "refund" : "invoice",
    description: invoiceDescription(invoice),
    amountUsdMicros: (amount < 0n ? -amount : amount).toString(),
    creditDeltaUsdMicros: "0",
    creditDelta: 0n,
    derived: false,
    status: invoice.status,
    invoiceId: invoice.id,
    hostedInvoiceUrl: invoice.hostedInvoiceUrl ?? null,
  });
}

/**
 * Human label for an invoice period, e.g. `Jul 2026`. Returns null when the
 * period is missing, so callers can fall back rather than print a raw id.
 */
export function formatInvoicePeriodLabel(
  periodStart: string | null | undefined,
  periodEnd: string | null | undefined,
): string | null {
  const source = periodStart || periodEnd;
  if (!source) return null;
  const parsed = new Date(source);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed.toLocaleDateString("en-US", {
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  });
}

/**
 * Build the ledger, newest first.
 *
 * `endingCreditBalanceUsdMicros` anchors the running balance: rows are walked
 * backward from it so the newest row matches the live prepaid balance exactly.
 */
export function buildLedgerEntries(input: {
  grants: LedgerGrantInput[];
  dailyUsage: LedgerDailyUsageInput[];
  invoices: LedgerInvoiceInput[];
  planIncludedUsdMicros?: string | null;
  endingCreditBalanceUsdMicros?: string | null;
  /**
   * False when any input source degraded (soft timeout, failed lookup), so the
   * event chain may have holes. Running balances are suppressed rather than
   * computed from a partial chain. Defaults to true.
   */
  inputsComplete?: boolean;
}): LedgerEntry[] {
  type Draft = Omit<LedgerEntry, "balanceUsdMicros"> & {
    creditDelta: bigint;
  };

  const drafts: Draft[] = [];

  for (const grant of input.grants) {
    // Undated grants cannot be ordered against usage; skip rather than guess.
    if (!grant.date) continue;
    const amount = parseMicros(grant.amountUsdMicros);
    drafts.push({
      id: `grant:${grant.id}`,
      date: grant.date,
      type: "credit_purchased",
      description: grant.name?.trim() || "Prepaid credits added",
      amountUsdMicros: amount.toString(),
      creditDeltaUsdMicros: amount.toString(),
      creditDelta: amount,
      derived: false,
    });
  }

  for (const day of splitDailyUsageAgainstAllowance(
    input.dailyUsage,
    input.planIncludedUsdMicros,
  )) {
    if (day.usedUsdMicros === 0n) continue;
    const burn = day.creditBurnUsdMicros;
    drafts.push({
      id: `usage:${day.date}`,
      // Sort usage after same-day grants so credits are available to burn.
      date: `${day.date}T23:59:59.999Z`,
      type: "usage",
      // Metered spend is activity, not an open receivable — Connect invoices
      // (and prepaid drawdowns via creditDelta) are what settled the bill.
      description:
        burn > 0n ? "Usage (metered)" : "Usage — covered by plan",
      amountUsdMicros: day.usedUsdMicros.toString(),
      creditDeltaUsdMicros: (-burn).toString(),
      creditDelta: -burn,
      derived: true,
    });
  }

  for (const invoice of input.invoices) {
    pushInvoiceDrafts(drafts, invoice);
  }

  const ordered = drafts
    .filter((draft) => draft.date)
    .sort((a, b) => {
      const cmp = a.date.localeCompare(b.date);
      return cmp !== 0 ? cmp : a.id.localeCompare(b.id);
    });

  // Walk backward from the live balance so the newest row reconciles exactly.
  // This is only sound when every balance-moving event is present: a hole in
  // the chain silently shifts every earlier balance by the missing delta.
  const complete = input.inputsComplete !== false;
  const endingBalance = parseMicros(input.endingCreditBalanceUsdMicros);
  const balances = new Array<bigint>(ordered.length);
  let running = endingBalance;
  for (let i = ordered.length - 1; i >= 0; i -= 1) {
    balances[i] = running;
    running -= ordered[i].creditDelta;
  }

  return ordered
    .map((draft, index) => {
      const { creditDelta: _creditDelta, ...rest } = draft;
      return {
        ...rest,
        balanceUsdMicros: complete ? balances[index].toString() : null,
      };
    })
    .reverse();
}

/** Filter helper shared by the ledger UI. */
export function filterLedgerEntries(
  entries: LedgerEntry[],
  filters: { types?: LedgerEntryType[]; from?: string | null; to?: string | null },
): LedgerEntry[] {
  const typeSet =
    filters.types && filters.types.length > 0 ? new Set(filters.types) : null;
  return entries.filter((entry) => {
    if (typeSet && !typeSet.has(entry.type)) return false;
    if (filters.from && entry.date < filters.from) return false;
    if (filters.to && entry.date > filters.to) return false;
    return true;
  });
}
