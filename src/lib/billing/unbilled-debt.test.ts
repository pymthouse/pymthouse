import assert from "node:assert/strict";
import test from "node:test";

import {
  gatheringTotalUsdMicros,
  netBillableMeterDebtUsdMicros,
  paidInvoiceTotalUsdMicrosSince,
  unbilledInvoiceDebtFromItems,
} from "@/lib/billing/unbilled-debt";

test("gatheringTotalUsdMicros parses dollars, micros strings, and rejects garbage", () => {
  assert.equal(gatheringTotalUsdMicros(null), null);
  assert.equal(gatheringTotalUsdMicros(undefined), null);
  assert.equal(gatheringTotalUsdMicros({}), null);
  assert.equal(gatheringTotalUsdMicros(Number.NaN), null);
  assert.equal(gatheringTotalUsdMicros(Number.POSITIVE_INFINITY), null);
  assert.equal(gatheringTotalUsdMicros(1.25), 1_250_000n);
  assert.equal(gatheringTotalUsdMicros(1.5), 1_500_000n);
  assert.equal(gatheringTotalUsdMicros("2.50"), 2_500_000n);
  assert.equal(gatheringTotalUsdMicros("5.00"), 5_000_000n);
  assert.equal(gatheringTotalUsdMicros("12.34"), 12_340_000n);
  assert.equal(gatheringTotalUsdMicros("10"), 10_000_000n);
  assert.equal(gatheringTotalUsdMicros("   "), null);
  assert.equal(gatheringTotalUsdMicros(""), null);
  // Long integer strings are treated as micros (OpenMeter sometimes returns micros).
  assert.equal(gatheringTotalUsdMicros("123456789"), 123_456_789n);
  assert.equal(gatheringTotalUsdMicros("100000000"), 100_000_000n);
  assert.equal(gatheringTotalUsdMicros("not-a-number"), null);
  assert.equal(gatheringTotalUsdMicros({} as unknown as string), null);
  assert.equal(gatheringTotalUsdMicros(true as unknown as string), null);
});

test("netBillableMeterDebtUsdMicros subtracts remaining included usage", () => {
  assert.equal(
    netBillableMeterDebtUsdMicros({
      meterUsdMicros: 2_040_000n,
      remainingIncludedUsdMicros: 5_000_000n,
    }),
    0n,
  );
  assert.equal(
    netBillableMeterDebtUsdMicros({
      meterUsdMicros: 7_000_000n,
      remainingIncludedUsdMicros: 5_000_000n,
    }),
    2_000_000n,
  );
  assert.equal(
    netBillableMeterDebtUsdMicros({
      meterUsdMicros: 1_000_000n,
      remainingIncludedUsdMicros: 0n,
    }),
    1_000_000n,
  );
});

// getUnbilledDebtDetails folds included-plan total + already-collected
// Stripe money (paid invoices AND standalone Checkout PaymentIntents)
// into this same subtrahend rather than giving the helper extra
// parameters. Two bugs this covers:
//
// 1. Calendar-month meter includes usage already paid mid-cycle. Without
//    netting, the account looks stuck in debt for the rest of the month.
// 2. Subtracting only leftover included usage left the consumed included
//    grant inside "unbilled". Once spendable hit $0, Available read as
//    −(whole month) instead of −(meter − included − already paid).
test("netBillableMeterDebtUsdMicros: paid-this-cycle netting clears a paid invoice's usage", () => {
  const wholeMonthMeterTotal = 1_071_000_000n; // $1,071 — everything charged this cycle
  const paidEarlierThisCycle = 1_061_000_000n; // $1,061 already collected via an invoice
  const remainingIncluded = 0n;
  assert.equal(
    netBillableMeterDebtUsdMicros({
      meterUsdMicros: wholeMonthMeterTotal,
      remainingIncludedUsdMicros: remainingIncluded + paidEarlierThisCycle,
    }),
    10_000_000n, // $10 of genuinely new, unbilled usage since that payment
  );
});

test("netBillableMeterDebtUsdMicros: Checkout top-ups and consumed included are not unbilled", () => {
  // Live shape from eu_43eac8e3… (2026-08-13): $1,164.50 metered, $5
  // Starter included (all consumed), $16 paid invoice, $1,111 Checkout
  // top-ups that never became a Stripe invoice. Before PaymentIntents
  // were folded into alreadyCollected, Available read −$1,164.50.
  const meter = 1_164_500_000n;
  const includedTotal = 5_000_000n;
  const paidInvoice = 16_000_000n;
  const topUpPayments = 1_111_000_000n;
  assert.equal(
    netBillableMeterDebtUsdMicros({
      meterUsdMicros: meter,
      remainingIncludedUsdMicros: includedTotal + paidInvoice + topUpPayments,
    }),
    32_500_000n,
  );
});

test("unbilledInvoiceDebtFromItems returns 0 for empty successful list", () => {
  assert.equal(unbilledInvoiceDebtFromItems([], "cus_1"), 0n);
});

test("unbilledInvoiceDebtFromItems ignores paid invoices (no meter fallthrough)", () => {
  assert.equal(
    unbilledInvoiceDebtFromItems(
      [
        {
          status: "paid",
          customer: { id: "cus_1" },
          totals: { total: "12.00" },
        },
        {
          status: "paid",
          customerId: "cus_1",
          totals: { total: "10.00" },
        },
      ],
      "cus_1",
    ),
    0n,
  );
});

test("unbilledInvoiceDebtFromItems uses max gathering plus unpaid open", () => {
  assert.equal(
    unbilledInvoiceDebtFromItems(
      [
        {
          status: "gathering",
          customer: { id: "cus_1" },
          totals: { total: "5.00" },
        },
        {
          status: "gathering",
          customer: { id: "cus_1" },
          totals: { total: "8.00" },
        },
        {
          status: "draft.syncing",
          customer: { id: "cus_1" },
          totals: { total: "12.00" },
        },
        {
          status: "paid",
          customer: { id: "cus_1" },
          totals: { total: "99.00" },
        },
        {
          status: "issuing.sync",
          customer: { id: "cus_other" },
          totals: { total: "50.00" },
        },
      ],
      "cus_1",
    ),
    // max gathering 8 + unpaid draft 12
    20_000_000n,
  );
});

test("unbilledInvoiceDebtFromItems counts unpaid open without gathering", () => {
  assert.equal(
    unbilledInvoiceDebtFromItems(
      [
        {
          status: "payment_processing.pending",
          customer: { id: "cus_1" },
          totals: { total: "3.50" },
        },
        {
          status: "overdue",
          customer: { id: "cus_1" },
          totals: { total: "1.25" },
        },
      ],
      "cus_1",
    ),
    4_750_000n,
  );
});

test("unbilledInvoiceDebtFromItems ignores invoices without a matching customer id", () => {
  // Unfiltered Konnect pages can omit customer.id. Those rows must not invent
  // debt for this subject or short-circuit the meter cross-check.
  assert.equal(
    unbilledInvoiceDebtFromItems(
      [
        {
          status: "gathering",
          totals: { total: "99.00" },
        },
        {
          status: "draft",
          customer: { id: "cus_other" },
          totals: { total: "50.00" },
        },
        {
          status: "gathering",
          customer: "cus_1",
          totals: { total: "2.00" },
        },
      ],
      "cus_1",
    ),
    2_000_000n,
  );
  assert.equal(
    unbilledInvoiceDebtFromItems(
      [
        {
          status: "gathering",
          totals: { total: "99.00" },
        },
        {
          status: "issued",
          customerId: null,
          totals: { total: "12.00" },
        },
      ],
      "cus_1",
    ),
    0n,
  );
});

test("paidInvoiceTotalUsdMicrosSince nets owner-rail mid-cycle paid invoices", () => {
  const cycleStart = Date.parse("2026-08-01T00:00:00.000Z");
  assert.equal(
    paidInvoiceTotalUsdMicrosSince(
      [
        {
          status: "paid",
          customer: { id: "cus_owner" },
          totals: { total: "1061.00" },
          createdAt: "2026-08-10T12:00:00.000Z",
        },
        {
          status: "paid",
          customer: { id: "cus_owner" },
          totals: { total: "5.00" },
          createdAt: "2026-07-31T23:00:00.000Z",
        },
        {
          status: "gathering",
          customer: { id: "cus_owner" },
          totals: { total: "10.00" },
          createdAt: "2026-08-13T12:00:00.000Z",
        },
        {
          status: "paid",
          customer: { id: "cus_other" },
          totals: { total: "999.00" },
          createdAt: "2026-08-10T12:00:00.000Z",
        },
      ],
      "cus_owner",
      cycleStart,
    ),
    1_061_000_000n,
  );
});
