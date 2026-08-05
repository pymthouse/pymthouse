import assert from "node:assert/strict";
import test from "node:test";

import { mapStripeInvoice } from "@/lib/stripe/owner-platform-invoices";

test("mapStripeInvoice prefers amount_due for open invoices with zero amount_paid", () => {
  const row = mapStripeInvoice({
    id: "in_open",
    status: "open",
    amount_paid: 0,
    amount_due: 2500,
    currency: "usd",
    created: 1_720_000_000,
  });
  assert.ok(row);
  assert.equal(row.status, "open");
  assert.equal(row.amountCents, 2500);
});

test("mapStripeInvoice prefers amount_paid for paid invoices", () => {
  const row = mapStripeInvoice({
    id: "in_paid",
    status: "paid",
    amount_paid: 1999,
    amount_due: 1999,
    currency: "usd",
    created: 1_720_000_000,
  });
  assert.ok(row);
  assert.equal(row.amountCents, 1999);
});
