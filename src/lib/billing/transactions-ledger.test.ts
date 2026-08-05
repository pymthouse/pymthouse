import assert from "node:assert/strict";
import test from "node:test";

import {
  buildLedgerEntries,
  filterLedgerEntries,
  formatInvoicePeriodLabel,
  splitDailyUsageAgainstAllowance,
} from "@/lib/billing/transactions-ledger";

test("splitDailyUsageAgainstAllowance drains the allowance before credits", () => {
  const split = splitDailyUsageAgainstAllowance(
    [
      { date: "2026-07-01", usedUsdMicros: "3000000" },
      { date: "2026-07-02", usedUsdMicros: "3000000" },
      { date: "2026-07-03", usedUsdMicros: "1000000" },
    ],
    "5000000",
  );

  // Day 1 fits entirely in the allowance.
  assert.equal(split[0].creditBurnUsdMicros, 0n);
  // Day 2 straddles the boundary: $2 of allowance left, so $1 burns credits.
  assert.equal(split[1].creditBurnUsdMicros, 1000000n);
  // Day 3 is fully past the allowance.
  assert.equal(split[2].creditBurnUsdMicros, 1000000n);
});

test("splitDailyUsageAgainstAllowance treats every day as credit burn with no allowance", () => {
  const split = splitDailyUsageAgainstAllowance(
    [{ date: "2026-07-01", usedUsdMicros: "250000" }],
    null,
  );
  assert.equal(split[0].creditBurnUsdMicros, 250000n);
});

test("splitDailyUsageAgainstAllowance orders days chronologically before splitting", () => {
  // Out-of-order input must not change which day straddles the allowance.
  const split = splitDailyUsageAgainstAllowance(
    [
      { date: "2026-07-03", usedUsdMicros: "4000000" },
      { date: "2026-07-01", usedUsdMicros: "4000000" },
    ],
    "5000000",
  );

  assert.equal(split[0].date, "2026-07-01");
  assert.equal(split[0].creditBurnUsdMicros, 0n);
  assert.equal(split[1].date, "2026-07-03");
  assert.equal(split[1].creditBurnUsdMicros, 3000000n);
});

test("ledger running balance ends at the live prepaid balance", () => {
  const entries = buildLedgerEntries({
    grants: [
      { id: "g1", amountUsdMicros: "25000000", date: "2026-07-01T00:00:00Z" },
    ],
    dailyUsage: [{ date: "2026-07-05", usedUsdMicros: "6000000" }],
    invoices: [],
    planIncludedUsdMicros: "5000000",
    endingCreditBalanceUsdMicros: "24000000",
  });

  // Newest first — the top row must equal the balance shown elsewhere.
  assert.equal(entries[0].balanceUsdMicros, "24000000");
  // Walking back over the $1 burn returns the post-grant balance.
  assert.equal(entries[1].balanceUsdMicros, "25000000");
});

test("ledger records credit burn only for usage past the allowance", () => {
  const entries = buildLedgerEntries({
    grants: [],
    dailyUsage: [
      { date: "2026-07-01", usedUsdMicros: "1000000" },
      { date: "2026-07-20", usedUsdMicros: "6000000" },
    ],
    invoices: [],
    planIncludedUsdMicros: "5000000",
    endingCreditBalanceUsdMicros: "18000000",
  });

  const byId = new Map(entries.map((e) => [e.id, e]));
  assert.equal(byId.get("usage:2026-07-01")?.creditDeltaUsdMicros, "0");
  assert.equal(byId.get("usage:2026-07-01")?.description, "Usage — covered by plan");
  assert.equal(byId.get("usage:2026-07-20")?.creditDeltaUsdMicros, "-2000000");
  // Gross amount stays the full day's spend even when partly plan-covered.
  assert.equal(byId.get("usage:2026-07-20")?.amountUsdMicros, "6000000");
});

test("ledger marks synthesized usage rows as derived", () => {
  const entries = buildLedgerEntries({
    grants: [{ id: "g1", amountUsdMicros: "1000000", date: "2026-07-01T00:00:00Z" }],
    dailyUsage: [{ date: "2026-07-02", usedUsdMicros: "500000" }],
    invoices: [],
    endingCreditBalanceUsdMicros: "500000",
  });

  const usage = entries.find((e) => e.type === "usage");
  const grant = entries.find((e) => e.type === "credit_purchased");
  assert.equal(usage?.derived, true);
  assert.equal(grant?.derived, false);
});

test("ledger skips undated grants rather than mis-ordering them", () => {
  const entries = buildLedgerEntries({
    grants: [
      { id: "dated", amountUsdMicros: "1000000", date: "2026-07-01T00:00:00Z" },
      { id: "undated", amountUsdMicros: "9000000", date: null },
    ],
    dailyUsage: [],
    invoices: [],
    endingCreditBalanceUsdMicros: "1000000",
  });

  assert.equal(entries.length, 1);
  assert.equal(entries[0].id, "grant:dated");
});

test("ledger emits one row per non-zero invoice line with kind labels", () => {
  const entries = buildLedgerEntries({
    grants: [],
    dailyUsage: [],
    invoices: [
      {
        id: "inv_plan",
        status: "paid",
        totalAmountUsdMicros: "2460000",
        issuedAt: "2026-08-01T00:00:00Z",
        lines: [
          {
            id: "sub",
            name: "Producer",
            totalAmountUsdMicros: "20000000",
            kind: "subscription",
          },
          {
            id: "prorate",
            name: "Unused period",
            totalAmountUsdMicros: "-17540000",
            kind: "proration",
          },
          {
            id: "usage",
            name: "Network fee",
            totalAmountUsdMicros: "430000",
            kind: "usage",
          },
          {
            id: "zero",
            name: "Zero line",
            totalAmountUsdMicros: "0",
            kind: "other",
          },
        ],
      },
    ],
    endingCreditBalanceUsdMicros: "0",
  });

  assert.equal(entries.length, 3);
  assert.deepEqual(
    entries.map((e) => e.description).sort(),
    [
      "Plan · Producer",
      "Proration · Unused period",
      "Usage · Network fee",
    ].sort(),
  );
  assert.ok(entries.every((e) => e.invoiceId === "inv_plan"));
  assert.ok(entries.every((e) => e.creditDeltaUsdMicros === "0"));
  const prorate = entries.find((e) => e.id.includes("prorate"));
  assert.equal(prorate?.type, "refund");
  assert.equal(prorate?.amountUsdMicros, "17540000");
});

test("ledger falls back to invoice header when lines are missing", () => {
  const entries = buildLedgerEntries({
    grants: [],
    dailyUsage: [],
    invoices: [
      {
        id: "inv_header",
        status: "paid",
        totalAmountUsdMicros: "2500000",
        issuedAt: "2026-07-31T00:00:00Z",
        periodStart: "2026-07-01T00:00:00Z",
        lines: [],
      },
    ],
    endingCreditBalanceUsdMicros: "0",
  });

  assert.equal(entries.length, 1);
  assert.equal(entries[0].id, "invoice:inv_header");
  assert.equal(entries[0].description, "Invoice · Jul 2026");
});

test("ledger maps credit_note invoice type to refund", () => {
  const entries = buildLedgerEntries({
    grants: [],
    dailyUsage: [],
    invoices: [
      {
        id: "inv_cn",
        status: "paid",
        totalAmountUsdMicros: "500000",
        issuedAt: "2026-07-15T00:00:00Z",
        invoiceType: "credit_note",
      },
    ],
    endingCreditBalanceUsdMicros: "0",
  });

  assert.equal(entries[0].type, "refund");
  assert.equal(entries[0].amountUsdMicros, "500000");
});

test("ledger classifies negative invoice totals as refunds", () => {
  const entries = buildLedgerEntries({
    grants: [],
    dailyUsage: [],
    invoices: [
      {
        id: "inv_refund",
        status: "paid",
        totalAmountUsdMicros: "-1500000",
        issuedAt: "2026-07-15T00:00:00Z",
      },
    ],
    endingCreditBalanceUsdMicros: "0",
  });

  assert.equal(entries[0].type, "refund");
  // Gross amount is displayed positive.
  assert.equal(entries[0].amountUsdMicros, "1500000");
});

test("ledger is ordered newest first", () => {
  const entries = buildLedgerEntries({
    grants: [
      { id: "old", amountUsdMicros: "1000000", date: "2026-07-01T00:00:00Z" },
      { id: "new", amountUsdMicros: "1000000", date: "2026-07-20T00:00:00Z" },
    ],
    dailyUsage: [],
    invoices: [],
    endingCreditBalanceUsdMicros: "2000000",
  });

  assert.deepEqual(
    entries.map((e) => e.id),
    ["grant:new", "grant:old"],
  );
});

test("filterLedgerEntries filters by type and date range", () => {
  const entries = buildLedgerEntries({
    grants: [{ id: "g1", amountUsdMicros: "1000000", date: "2026-07-01T00:00:00Z" }],
    dailyUsage: [{ date: "2026-07-20", usedUsdMicros: "500000" }],
    invoices: [],
    endingCreditBalanceUsdMicros: "500000",
  });

  assert.equal(filterLedgerEntries(entries, { types: ["usage"] }).length, 1);
  assert.equal(
    filterLedgerEntries(entries, { types: ["credit_purchased"] }).length,
    1,
  );
  assert.equal(
    filterLedgerEntries(entries, { from: "2026-07-10" }).length,
    1,
    "entries before the from-date are excluded",
  );
  assert.equal(filterLedgerEntries(entries, {}).length, 2);
  // The UI extends `to` to end-of-day; the same-day usage row must stay in.
  assert.equal(
    filterLedgerEntries(entries, { to: "2026-07-20T23:59:59.999Z" }).length,
    2,
  );
  assert.equal(filterLedgerEntries(entries, { to: "2026-07-02" }).length, 1);
});

test("formatInvoicePeriodLabel prefers the period start and falls back safely", () => {
  assert.equal(formatInvoicePeriodLabel("2026-07-01T00:00:00Z", null), "Jul 2026");
  assert.equal(formatInvoicePeriodLabel(null, "2026-08-31T00:00:00Z"), "Aug 2026");
  assert.equal(formatInvoicePeriodLabel(null, null), null);
  assert.equal(formatInvoicePeriodLabel("nonsense", null), null);
});

test("incomplete inputs suppress running balances instead of guessing", () => {
  // A soft-timeout on grants or usage leaves holes in the event chain, so every
  // balance derived by walking back from the live balance would be wrong.
  const entries = buildLedgerEntries({
    grants: [{ id: "g1", amountUsdMicros: "25000000", date: "2026-07-01T00:00:00Z" }],
    dailyUsage: [{ date: "2026-07-05", usedUsdMicros: "6000000" }],
    invoices: [],
    planIncludedUsdMicros: "5000000",
    endingCreditBalanceUsdMicros: "24000000",
    inputsComplete: false,
  });

  assert.ok(entries.length > 0, "entries are still listed");
  assert.ok(
    entries.every((entry) => entry.balanceUsdMicros === null),
    "no entry claims a balance it cannot substantiate",
  );
  // The events themselves are still accurate; only the derived column is withheld.
  assert.equal(entries[0].creditDeltaUsdMicros, "-1000000");
});

test("inputsComplete defaults to true so existing callers are unaffected", () => {
  const entries = buildLedgerEntries({
    grants: [{ id: "g1", amountUsdMicros: "1000000", date: "2026-07-01T00:00:00Z" }],
    dailyUsage: [],
    invoices: [],
    endingCreditBalanceUsdMicros: "1000000",
  });
  assert.equal(entries[0].balanceUsdMicros, "1000000");
});
