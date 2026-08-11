import assert from "node:assert/strict";
import test from "node:test";

import { invoiceDisplayLabel } from "@/components/billing/PlatformInvoicesTable";
import type { TenantInvoiceDto } from "@/lib/openmeter/invoices";

function invoice(partial: Partial<TenantInvoiceDto>): TenantInvoiceDto {
  return {
    id: "inv_1",
    status: "paid",
    currency: "USD",
    totalAmount: "2.46",
    periodStart: "2026-08-01T00:00:00Z",
    ...partial,
  };
}

test("invoiceDisplayLabel uses plan-change when lines mix fee and proration", () => {
  assert.equal(
    invoiceDisplayLabel(
      invoice({
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
      }),
    ),
    "Plan change · Aug 2026",
  );
});

test("invoiceDisplayLabel keeps usage overage for usage-only invoices", () => {
  assert.equal(
    invoiceDisplayLabel(
      invoice({
        totalAmount: "0.43",
        periodStart: "2026-07-01T00:00:00Z",
        lines: [
          {
            id: "u",
            name: "Network fee",
            totalAmount: "0.43",
            kind: "usage",
          },
        ],
      }),
    ),
    "Usage overage · Jul 2026",
  );
});
