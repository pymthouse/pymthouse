/**
 * Classify OpenMeter invoice lines for billing UI / transactions ledger.
 * Client-safe (no DB/Node imports).
 */

export type InvoiceLineKind =
  | "subscription"
  | "proration"
  | "usage"
  | "other";

export type InvoiceLineSummary = {
  id: string;
  name: string;
  description?: string;
  /** Decimal dollar string from OpenMeter totals.total (may be negative). */
  totalAmount: string;
  kind: InvoiceLineKind;
  periodStart?: string;
  periodEnd?: string;
};

function lineText(line: { name?: string; description?: string }): string {
  return `${line.name ?? ""} ${line.description ?? ""}`.toLowerCase();
}

/**
 * Heuristic kind for an OpenMeter invoice line / detailed child line.
 * Proration credits and subscription flat fees must not be labeled "usage overage".
 */
export function classifyInvoiceLineKind(line: {
  name?: string;
  description?: string;
  type?: string;
  category?: string;
  managedBy?: string;
}): InvoiceLineKind {
  const text = lineText(line);
  if (
    /prorat|unused\s+(time|period|portion)|credit\s+for|remaining\s+period|partial\s+period/.test(
      text,
    )
  ) {
    return "proration";
  }
  if (
    line.type === "flat_fee" ||
    line.managedBy === "subscription" ||
    /subscription(\s+fee)?|monthly\s+fee|flat\s+fee|producer|owner\s+paid/.test(
      text,
    )
  ) {
    return "subscription";
  }
  if (
    line.type === "usage_based" ||
    /usage|overage|network\s+fee|meter/.test(text)
  ) {
    return "usage";
  }
  return "other";
}

/** Human label for a single line in the transactions ledger. */
export function invoiceLineLedgerDescription(line: InvoiceLineSummary): string {
  const name = line.name.trim() || "Charge";
  if (line.kind === "proration") {
    return `Proration · ${name}`;
  }
  if (line.kind === "subscription") {
    return `Plan · ${name}`;
  }
  if (line.kind === "usage") {
    return `Usage · ${name}`;
  }
  return name;
}

/**
 * Invoice table / aggregate label from lines (falls back when lines missing).
 */
export function invoiceSummaryLabel(input: {
  lines?: InvoiceLineSummary[] | null;
  totalAmount?: string | null;
  periodLabel?: string | null;
}): string {
  const lines = input.lines ?? [];
  const kinds = new Set(lines.map((l) => l.kind));
  let base: string;
  if (lines.length === 0) {
    const zero = !input.totalAmount || /^0(\.0+)?$/.test(input.totalAmount.trim());
    base = zero ? "No charges" : "Invoice";
  } else if (kinds.size === 1 && kinds.has("subscription")) {
    base = "Subscription";
  } else if (kinds.size === 1 && kinds.has("proration")) {
    base = "Proration";
  } else if (kinds.size === 1 && kinds.has("usage")) {
    base = "Usage overage";
  } else if (kinds.has("subscription") || kinds.has("proration")) {
    base = "Plan change";
  } else {
    base = "Invoice";
  }
  return input.periodLabel ? `${base} · ${input.periodLabel}` : base;
}
