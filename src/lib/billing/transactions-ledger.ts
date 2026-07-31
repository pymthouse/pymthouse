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
  /** Prepaid credit balance after this entry (USD micros). */
  balanceUsdMicros: string;
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

export type LedgerInvoiceInput = {
  id: string;
  number?: string | null;
  status: string;
  totalAmountUsdMicros: string;
  issuedAt?: string | null;
  periodStart?: string | null;
  periodEnd?: string | null;
  hostedInvoiceUrl?: string | null;
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

function invoiceDescription(invoice: LedgerInvoiceInput): string {
  const period = formatInvoicePeriodLabel(invoice.periodStart, invoice.periodEnd);
  return period ? `Invoice · ${period}` : "Invoice";
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
      description:
        burn > 0n ? "Usage — beyond plan allowance" : "Usage — covered by plan",
      amountUsdMicros: day.usedUsdMicros.toString(),
      creditDeltaUsdMicros: (-burn).toString(),
      creditDelta: -burn,
      derived: true,
    });
  }

  for (const invoice of input.invoices) {
    const amount = parseMicros(invoice.totalAmountUsdMicros);
    const isRefund = amount < 0n;
    drafts.push({
      id: `invoice:${invoice.id}`,
      date: invoice.issuedAt || invoice.periodEnd || invoice.periodStart || "",
      type: isRefund ? "refund" : "invoice",
      description: invoiceDescription(invoice),
      amountUsdMicros: (isRefund ? -amount : amount).toString(),
      // Invoices settle outside the prepaid wallet — no credit movement.
      creditDeltaUsdMicros: "0",
      creditDelta: 0n,
      derived: false,
      status: invoice.status,
      invoiceId: invoice.id,
      hostedInvoiceUrl: invoice.hostedInvoiceUrl ?? null,
    });
  }

  const ordered = drafts
    .filter((draft) => draft.date)
    .sort((a, b) => {
      const cmp = a.date.localeCompare(b.date);
      return cmp !== 0 ? cmp : a.id.localeCompare(b.id);
    });

  // Walk backward from the live balance so the newest row reconciles exactly.
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
      return { ...rest, balanceUsdMicros: balances[index].toString() };
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
