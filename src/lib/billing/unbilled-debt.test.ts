import assert from "node:assert/strict";
import test from "node:test";

import {
  gatheringTotalUsdMicros,
  netBillableMeterDebtUsdMicros,
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

// getUnbilledDebtDetails folds "already collected this cycle" into this same
// subtrahend (remainingIncludedUsdMicros + alreadyCollected) rather than
// giving netBillableMeterDebtUsdMicros a third parameter, so this is the
// exact bug the fix targets: the calendar-month meter sum includes usage
// already paid off mid-cycle, and without netting it out the account looks
// stuck in debt for the rest of the month right after clearing it.
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
