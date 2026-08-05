import type { TenantInvoiceDto } from "@/lib/openmeter/invoices";
import type { OwnerStripeInvoiceItem } from "@/lib/stripe/owner-platform-invoices";

/**
 * Unified row for /billing Platform invoices: OpenMeter invoices plus any
 * Stripe receipts not already linked via externalInvoicingId.
 */
export type PlatformInvoiceDisplayRow = TenantInvoiceDto & {
  source: "openmeter" | "stripe";
  /** When known (Stripe list), open directly without the hosted-url round-trip. */
  hostedInvoiceUrl?: string | null;
};

/** USD cents → decimal dollars string for TenantInvoiceDto.totalAmount. */
export function centsToDecimalDollars(cents: number): string {
  const n = Number.isFinite(cents) ? Math.trunc(cents) : 0;
  const sign = n < 0 ? "-" : "";
  const abs = Math.abs(n);
  const whole = Math.floor(abs / 100);
  const frac = String(abs % 100).padStart(2, "0");
  return `${sign}${whole}.${frac}`;
}

export function stripeInvoiceToDisplayRow(
  inv: OwnerStripeInvoiceItem,
): PlatformInvoiceDisplayRow {
  return {
    id: inv.id,
    number: inv.number ?? undefined,
    status: inv.status,
    currency: inv.currency,
    totalAmount: centsToDecimalDollars(inv.amountCents),
    issuedAt: inv.createdAt,
    externalInvoicingId: inv.id,
    source: "stripe",
    hostedInvoiceUrl: inv.hostedInvoiceUrl,
  };
}

/**
 * Prefer OpenMeter rows (line kinds / periods). Attach Stripe hosted URL when
 * matched; append unmatched Stripe paid/open receipts as Stripe-only rows.
 */
export function mergePlatformInvoiceRows(
  openMeterInvoices: TenantInvoiceDto[],
  stripeInvoices: OwnerStripeInvoiceItem[],
): PlatformInvoiceDisplayRow[] {
  const byStripeId = new Map(
    stripeInvoices.map((inv) => [inv.id, inv] as const),
  );
  const usedStripeIds = new Set<string>();
  const rows: PlatformInvoiceDisplayRow[] = [];

  for (const inv of openMeterInvoices) {
    const ext = inv.externalInvoicingId?.trim();
    const match = ext ? byStripeId.get(ext) : undefined;
    if (match) {
      usedStripeIds.add(match.id);
    }
    rows.push({
      ...inv,
      source: "openmeter",
      hostedInvoiceUrl: match?.hostedInvoiceUrl ?? null,
    });
  }

  for (const inv of stripeInvoices) {
    if (usedStripeIds.has(inv.id)) continue;
    rows.push(stripeInvoiceToDisplayRow(inv));
  }

  rows.sort((a, b) => (b.issuedAt ?? "").localeCompare(a.issuedAt ?? ""));
  return rows;
}
