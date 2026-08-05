import assert from "node:assert/strict";
import test from "node:test";

import {
  centsToDecimalDollars,
  mergePlatformInvoiceRows,
  stripeInvoiceToDisplayRow,
} from "@/lib/billing/platform-invoice-rows";
import type { TenantInvoiceDto } from "@/lib/openmeter/invoices";
import type { OwnerStripeInvoiceItem } from "@/lib/stripe/owner-platform-invoices";

test("centsToDecimalDollars formats USD cents", () => {
  assert.equal(centsToDecimalDollars(250), "2.50");
  assert.equal(centsToDecimalDollars(0), "0.00");
  assert.equal(centsToDecimalDollars(5), "0.05");
  assert.equal(centsToDecimalDollars(-199), "-1.99");
});

test("mergePlatformInvoiceRows prefers OpenMeter and dedupes by Stripe id", () => {
  const om: TenantInvoiceDto[] = [
    {
      id: "om_1",
      status: "paid",
      currency: "USD",
      totalAmount: "2.50",
      issuedAt: "2026-08-01T00:00:00.000Z",
      externalInvoicingId: "in_stripe_1",
      lines: [
        {
          id: "l1",
          name: "Producer",
          totalAmount: "2.50",
          kind: "subscription",
        },
      ],
    },
  ];
  const stripe: OwnerStripeInvoiceItem[] = [
    {
      id: "in_stripe_1",
      number: "INV-1",
      status: "paid",
      currency: "USD",
      amountCents: 250,
      createdAt: "2026-08-01T00:00:00.000Z",
      hostedInvoiceUrl: "https://invoice.stripe.com/i/in_stripe_1",
      invoicePdf: null,
    },
    {
      id: "in_stripe_2",
      number: "INV-2",
      status: "paid",
      currency: "USD",
      amountCents: 2000,
      createdAt: "2026-07-01T00:00:00.000Z",
      hostedInvoiceUrl: "https://invoice.stripe.com/i/in_stripe_2",
      invoicePdf: null,
    },
  ];

  const rows = mergePlatformInvoiceRows(om, stripe);
  assert.equal(rows.length, 2);
  assert.equal(rows[0]!.id, "om_1");
  assert.equal(rows[0]!.source, "openmeter");
  assert.equal(
    rows[0]!.hostedInvoiceUrl,
    "https://invoice.stripe.com/i/in_stripe_1",
  );
  assert.equal(rows[1]!.id, "in_stripe_2");
  assert.equal(rows[1]!.source, "stripe");
  assert.equal(rows[1]!.totalAmount, "20.00");
});

test("stripeInvoiceToDisplayRow maps Stripe receipt fields", () => {
  const row = stripeInvoiceToDisplayRow({
    id: "in_x",
    number: "42",
    status: "open",
    currency: "usd",
    amountCents: 99,
    createdAt: "2026-08-05T12:00:00.000Z",
    hostedInvoiceUrl: "https://example.com/i",
    invoicePdf: null,
  });
  assert.equal(row.source, "stripe");
  assert.equal(row.totalAmount, "0.99");
  assert.equal(row.externalInvoicingId, "in_x");
  assert.equal(row.hostedInvoiceUrl, "https://example.com/i");
});

test("stripeInvoiceToDisplayRow preserves PDF when hosted URL is null", () => {
  const row = stripeInvoiceToDisplayRow({
    id: "in_pdf",
    number: null,
    status: "paid",
    currency: "USD",
    amountCents: 500,
    createdAt: "2026-08-05T12:00:00.000Z",
    hostedInvoiceUrl: null,
    invoicePdf: "https://files.stripe.com/invoices/in_pdf/pdf",
  });
  assert.equal(row.hostedInvoiceUrl, null);
  assert.equal(row.invoicePdf, "https://files.stripe.com/invoices/in_pdf/pdf");
});

test("mergePlatformInvoiceRows with empty OM still shows Stripe receipts", () => {
  const stripe: OwnerStripeInvoiceItem[] = [
    {
      id: "in_only",
      number: null,
      status: "paid",
      currency: "USD",
      amountCents: 250,
      createdAt: "2026-08-04T00:00:00.000Z",
      hostedInvoiceUrl: null,
      invoicePdf: null,
    },
  ];
  const rows = mergePlatformInvoiceRows([], stripe);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.source, "stripe");
});
