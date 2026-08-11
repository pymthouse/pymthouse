import assert from "node:assert/strict";
import test from "node:test";

import {
  classifyInvoiceLineKind,
  invoiceLineLedgerDescription,
  invoiceSummaryLabel,
} from "@/lib/billing/invoice-line-labels";

test("classifyInvoiceLineKind detects proration before usage keywords", () => {
  assert.equal(
    classifyInvoiceLineKind({
      name: "Unused time credit",
      description: "Credit for remaining period",
      type: "usage_based",
    }),
    "proration",
  );
});

test("classifyInvoiceLineKind detects subscription flat fees", () => {
  assert.equal(
    classifyInvoiceLineKind({
      name: "Producer",
      type: "flat_fee",
      managedBy: "subscription",
    }),
    "subscription",
  );
});

test("classifyInvoiceLineKind detects usage overage", () => {
  assert.equal(
    classifyInvoiceLineKind({
      name: "Network fee",
      type: "usage_based",
    }),
    "usage",
  );
});

test("invoiceLineLedgerDescription prefixes by kind", () => {
  assert.equal(
    invoiceLineLedgerDescription({
      id: "1",
      name: "Producer",
      totalAmount: "20.00",
      kind: "subscription",
    }),
    "Plan · Producer",
  );
  assert.equal(
    invoiceLineLedgerDescription({
      id: "2",
      name: "Unused period",
      totalAmount: "-17.54",
      kind: "proration",
    }),
    "Proration · Unused period",
  );
  assert.equal(
    invoiceLineLedgerDescription({
      id: "3",
      name: "Network fee",
      totalAmount: "0.43",
      kind: "usage",
    }),
    "Usage · Network fee",
  );
});

test("invoiceSummaryLabel prefers plan-change over blanket usage overage", () => {
  assert.equal(
    invoiceSummaryLabel({
      lines: [
        {
          id: "a",
          name: "Producer",
          totalAmount: "20",
          kind: "subscription",
        },
        {
          id: "b",
          name: "Unused",
          totalAmount: "-17.54",
          kind: "proration",
        },
      ],
      totalAmount: "2.46",
      periodLabel: "Aug 2026",
    }),
    "Plan change · Aug 2026",
  );
  assert.equal(
    invoiceSummaryLabel({
      lines: [
        {
          id: "u",
          name: "Network fee",
          totalAmount: "0.43",
          kind: "usage",
        },
      ],
      totalAmount: "0.43",
      periodLabel: "Jul 2026",
    }),
    "Usage overage · Jul 2026",
  );
  assert.equal(
    invoiceSummaryLabel({ lines: [], totalAmount: "0", periodLabel: null }),
    "No charges",
  );
  assert.equal(
    invoiceSummaryLabel({ lines: [], totalAmount: "2.46", periodLabel: null }),
    "Invoice",
  );
});
