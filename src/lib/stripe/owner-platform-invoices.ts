/**
 * Stripe platform (non-Connect) invoices for an owner's billing customer.
 * Complements OpenMeter invoice list — OM is semantic source; Stripe is the
 * collection rail and may show paid receipts before OM sync catches up.
 */

import { sanitizeForLog } from "@/lib/sanitize-for-log";
import {
  getHostedAdminClient,
  isHostedAdminClientAvailable,
} from "@/lib/openmeter/admin-client";
import {
  ensureOwnerCustomer,
  listOwnedPublicClientIds,
} from "@/lib/openmeter/customers";
import { getKonnectStripeBillingRefs } from "@/lib/openmeter/stripe-customer-data";
import { toStripeApiUrl } from "@/lib/openmeter/owner-payment-method";

const LIST_BUDGET_MS = 8_000;

function stripeSecretKeyOrNull(): string | null {
  const key =
    process.env.STRIPE_SECRET_KEY?.trim() || process.env.STRIPE_API_KEY?.trim();
  if (!key?.startsWith("sk_")) {
    return null;
  }
  return key;
}

export type OwnerStripeInvoiceItem = {
  id: string;
  number: string | null;
  status: string;
  currency: string;
  /** Amount paid / due in USD cents. */
  amountCents: number;
  createdAt: string;
  hostedInvoiceUrl: string | null;
  invoicePdf: string | null;
};

type StripeInvoiceApiRow = {
  id?: string;
  number?: string | null;
  status?: string | null;
  currency?: string | null;
  amount_paid?: number | null;
  amount_due?: number | null;
  created?: number | null;
  hosted_invoice_url?: string | null;
  invoice_pdf?: string | null;
};

function mapStripeInvoice(row: StripeInvoiceApiRow): OwnerStripeInvoiceItem | null {
  const id = row.id?.trim();
  if (!id) return null;
  const status = (row.status ?? "unknown").trim() || "unknown";
  let amountCents = 0;
  if (typeof row.amount_paid === "number") {
    amountCents = row.amount_paid;
  } else if (typeof row.amount_due === "number") {
    amountCents = row.amount_due;
  }
  const createdSec = typeof row.created === "number" ? row.created : 0;
  return {
    id,
    number: row.number?.trim() || null,
    status,
    currency: (row.currency ?? "usd").toUpperCase(),
    amountCents,
    createdAt: new Date(createdSec * 1000).toISOString(),
    hostedInvoiceUrl: row.hosted_invoice_url?.trim() || null,
    invoicePdf: row.invoice_pdf?.trim() || null,
  };
}

async function listStripeInvoicesForCustomer(
  stripeCustomerId: string,
  status: "paid" | "open",
  signal: AbortSignal,
): Promise<OwnerStripeInvoiceItem[]> {
  const key = stripeSecretKeyOrNull();
  if (!key) return [];

  const path =
    `/v1/invoices?customer=${encodeURIComponent(stripeCustomerId)}` +
    `&status=${status}&limit=20`;
  const res = await fetch(toStripeApiUrl(path), {
    method: "GET",
    headers: { Authorization: `Bearer ${key}` },
    signal,
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Stripe invoices list failed (${res.status}): ${body}`);
  }
  const json = (await res.json()) as { data?: StripeInvoiceApiRow[] };
  const out: OwnerStripeInvoiceItem[] = [];
  for (const row of json.data ?? []) {
    const mapped = mapStripeInvoice(row);
    if (mapped) out.push(mapped);
  }
  return out;
}

/**
 * Paid (+ open) Stripe invoices for the owner's platform Stripe customer.
 * Returns [] when Stripe/OpenMeter is unavailable or no customer exists.
 */
export async function listOwnerStripeInvoices(
  ownerUserId: string,
): Promise<OwnerStripeInvoiceItem[]> {
  const trimmed = ownerUserId.trim();
  if (!trimmed) return [];
  if (!isHostedAdminClientAvailable() || !stripeSecretKeyOrNull()) {
    return [];
  }

  try {
    const signal = AbortSignal.timeout(LIST_BUDGET_MS);
    const client = getHostedAdminClient();
    const publicClientIds = await listOwnedPublicClientIds(trimmed);
    const customer = await ensureOwnerCustomer(
      client,
      trimmed,
      publicClientIds,
    );
    const refs = await getKonnectStripeBillingRefs(customer.id, signal);
    const stripeCustomerId = refs.stripeCustomerId?.trim();
    if (!stripeCustomerId) {
      return [];
    }

    const [paid, open] = await Promise.all([
      listStripeInvoicesForCustomer(stripeCustomerId, "paid", signal),
      listStripeInvoicesForCustomer(stripeCustomerId, "open", signal),
    ]);

    const byId = new Map<string, OwnerStripeInvoiceItem>();
    for (const inv of [...paid, ...open]) {
      byId.set(inv.id, inv);
    }
    return [...byId.values()].toSorted((a, b) =>
      b.createdAt.localeCompare(a.createdAt),
    );
  } catch (err) {
    console.warn("owner-stripe-invoices: lookup failed", sanitizeForLog(err));
    return [];
  }
}
