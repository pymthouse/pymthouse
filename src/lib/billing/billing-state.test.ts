import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  type BillingStateInput,
  explainOverageCeiling,
  previewOverageCeiling,
  resolveBillingState,
} from "@/lib/billing/billing-state";

function input(overrides: Partial<BillingStateInput> = {}): BillingStateInput {
  return {
    asOf: new Date("2026-08-08T03:14:00.000Z"),
    currency: "USD",
    subject: {
      type: "end_user",
      externalUserId: "user-123",
      billingMode: "merchant",
    },
    prepaidUsdMicros: 0n,
    includedRemainingUsdMicros: 0n,
    overageEligible: true,
    softNegativeUsdMicros: 10_000_000n,
    unbilledDebtUsdMicros: 0n,
    debtSource: "gathering_invoice",
    leadUsdMicros: 5_000_000n,
    minimumChargeUsdMicros: 500_000n,
    collector: "settlement_connect",
    paymentMethod: { hasDefault: true, brand: "visa", last4: "7310" },
    billingAvailable: true,
    cycle: "P1M",
    collectionInterval: "P1D",
    ...overrides,
  };
}

describe("resolveBillingState status", () => {
  it("is active while any spendable allowance remains", () => {
    const state = resolveBillingState(
      input({ prepaidUsdMicros: 1n, overageEligible: false }),
    );
    assert.equal(state.status, "active");
    assert.equal(state.canSpend, true);
    assert.equal(state.reason, null);
  });

  it("counts plan discount toward spendable", () => {
    const state = resolveBillingState(
      input({ includedRemainingUsdMicros: 2_000_000n }),
    );
    assert.equal(state.status, "active");
    assert.equal(state.funding.spendable.usd, "2.00");
  });

  it("clears unbilledDebt while spendable remains (no double-count)", () => {
    const state = resolveBillingState(
      input({
        prepaidUsdMicros: 5_010_000n,
        unbilledDebtUsdMicros: 19_990_000n,
      }),
    );
    assert.equal(state.status, "active");
    assert.equal(state.funding.spendable.usd, "5.01");
    assert.equal(state.funding.overage.unbilledDebt?.usd, "0.00");
    assert.equal(state.funding.overage.remaining?.usd, "10.00");
  });

  it("is overage at zero spendable with room to spare", () => {
    const state = resolveBillingState(
      input({ unbilledDebtUsdMicros: 1_000_000n }),
    );
    assert.equal(state.status, "overage");
    assert.equal(state.canSpend, true);
    assert.equal(state.collection.nextAction, "none");
  });

  it("is at_risk once headroom enters the lead window", () => {
    // Ceiling $10, lead $5 → headroom of $5 or less is at_risk.
    const state = resolveBillingState(
      input({ unbilledDebtUsdMicros: 5_000_000n }),
    );
    assert.equal(state.status, "at_risk");
    assert.equal(state.canSpend, true);
    assert.equal(state.collection.nextAction, "awaiting_settlement");
    assert.equal(state.funding.overage.remaining?.usd, "5.00");
  });

  it("blocks at the ceiling", () => {
    const state = resolveBillingState(
      input({ unbilledDebtUsdMicros: 10_000_000n }),
    );
    assert.equal(state.status, "blocked");
    assert.equal(state.canSpend, false);
    assert.equal(state.reason, "debt_ceiling_reached");
    assert.equal(state.funding.overage.remaining?.usd, "0.00");
    assert.equal(state.funding.overage.utilizationBps, 10_000);
  });

  it("blocks without a payment method when overage is unavailable", () => {
    const state = resolveBillingState(
      input({
        overageEligible: false,
        paymentMethod: { hasDefault: false },
      }),
    );
    assert.equal(state.status, "blocked");
    assert.equal(state.reason, "no_payment_method");
    assert.equal(state.collection.nextAction, "add_payment_method");
  });

  it("distinguishes an ineligible account that does have a card", () => {
    const state = resolveBillingState(
      input({ overageEligible: false, paymentMethod: { hasDefault: true } }),
    );
    assert.equal(state.reason, "overage_not_available");
    assert.equal(state.collection.nextAction, "add_funds");
  });

  it("blocks when billing cannot be confirmed", () => {
    const state = resolveBillingState(input({ billingAvailable: false }));
    assert.equal(state.status, "blocked");
    assert.equal(state.reason, "billing_unavailable");
    assert.equal(state.collection.nextAction, "none");
  });

  it("treats a zero ceiling as unlimited overage", () => {
    const state = resolveBillingState(
      input({
        softNegativeUsdMicros: 0n,
        unbilledDebtUsdMicros: 99_000_000n,
      }),
    );
    assert.equal(state.status, "overage");
    assert.equal(state.funding.overage.remaining, null);
    assert.equal(state.funding.overage.utilizationBps, null);
  });

  it("stays permissive when debt could not be read", () => {
    // The gate performs its own authoritative lookup, so a read surface must
    // not invent a block from missing data.
    const state = resolveBillingState(
      input({ unbilledDebtUsdMicros: null, debtSource: "unavailable" }),
    );
    assert.equal(state.status, "overage");
    assert.equal(state.funding.overage.unbilledDebt, null);
    assert.equal(state.funding.overage.debtSource, "unavailable");
  });

  it("uses the derived lead window at the $2 minimum ceiling", () => {
    const at = resolveBillingState(
      input({
        softNegativeUsdMicros: 2_000_000n,
        leadUsdMicros: 1_000_000n,
        unbilledDebtUsdMicros: 1_000_000n,
      }),
    );
    assert.equal(at.status, "at_risk");
    const below = resolveBillingState(
      input({
        softNegativeUsdMicros: 2_000_000n,
        leadUsdMicros: 1_000_000n,
        unbilledDebtUsdMicros: 999_999n,
      }),
    );
    assert.equal(below.status, "overage");
  });
});

describe("resolveBillingState funding.net", () => {
  it("equals spendable when there is no unbilled debt", () => {
    const state = resolveBillingState(
      input({ prepaidUsdMicros: 5_000_000n, unbilledDebtUsdMicros: 0n }),
    );
    assert.equal(state.funding.net?.usd, "5.00");
  });

  it("goes negative once debt outruns spendable — a charge went unpaid", () => {
    const state = resolveBillingState(
      input({ prepaidUsdMicros: 0n, unbilledDebtUsdMicros: 12_340_000n }),
    );
    assert.equal(state.funding.net?.usd, "-12.34");
    assert.equal(state.funding.net?.usdMicros, "-12340000");
  });

  it("does not double-subtract debt the spendable balance already covers", () => {
    // Same fixture as "clears unbilledDebt while spendable remains": the
    // gathering total includes spendable-covered usage, so net must read
    // spendable exactly, not spendable minus the raw (uncleared) debt.
    const state = resolveBillingState(
      input({
        prepaidUsdMicros: 5_010_000n,
        unbilledDebtUsdMicros: 19_990_000n,
      }),
    );
    assert.equal(state.funding.net?.usd, "5.01");
  });

  it("is null exactly when debt is unavailable, matching overage.unbilledDebt", () => {
    const state = resolveBillingState(
      input({ unbilledDebtUsdMicros: null, debtSource: "unavailable" }),
    );
    assert.equal(state.funding.net, null);
    assert.equal(state.funding.overage.unbilledDebt, null);
  });

  it("goes further negative than a zero-floored ceiling remaining would show", () => {
    // At the ceiling, overage.remaining floors at $0.00 — net still reports
    // the real, uncapped shortfall so a blocked user sees they owe money,
    // not merely that their buffer is exhausted.
    const state = resolveBillingState(
      input({ unbilledDebtUsdMicros: 10_000_000n }),
    );
    assert.equal(state.status, "blocked");
    assert.equal(state.funding.overage.remaining?.usd, "0.00");
    assert.equal(state.funding.net?.usd, "-10.00");
  });
});

// The full lifecycle a user actually lives through: credit a prepaid amount,
// send usage that exceeds it, let the resulting debt accrue toward (and
// past) the ceiling, then confirm it charges and recovers cleanly once
// collected — without the gate getting stuck or a stale number lingering.
// resolveBillingState is pure, so "recovery" here really means: once the
// debt input correctly reads back down (getUnbilledDebtDetails's job, fixed
// separately for the case where already-paid usage this cycle was being
// double-counted as still owed), the gate reopens on the very next read with
// no separate reset step required.
describe("resolveBillingState credit -> overage -> charge -> recovery lifecycle", () => {
  it("credits $10, usage of $15 clears it and spends into overage while still allowing requests", () => {
    // $10 credited, $15 of usage: $10 drawn from spendable, $5 becomes debt.
    const state = resolveBillingState(
      input({ prepaidUsdMicros: 0n, unbilledDebtUsdMicros: 5_000_000n }),
    );
    assert.equal(state.canSpend, true, "usage past the credited amount must still go through while overage-eligible");
    assert.equal(state.funding.spendable.usd, "0.00");
    assert.equal(state.funding.overage.unbilledDebt?.usd, "5.00");
    assert.equal(state.funding.net?.usd, "-5.00", "net reflects the $5 owed, not a floored $0.00");
  });

  it("crossing the ceiling blocks further spend rather than letting debt run unbounded", () => {
    const state = resolveBillingState(
      input({ prepaidUsdMicros: 0n, unbilledDebtUsdMicros: 10_000_000n }), // ceiling is $10
    );
    assert.equal(state.status, "blocked");
    assert.equal(state.canSpend, false);
    assert.equal(state.reason, "debt_ceiling_reached");
    assert.equal(state.collection.nextAction, "awaiting_settlement");
  });

  it("recovers to active with a clean $0 debt and positive net the moment the charge is paid", () => {
    // Same subject, later read: settlement collected the invoice, so the
    // next unbilled-debt read reports 0 (this is exactly the read that used
    // to be wrong when the meter-estimate fallback still counted the
    // already-paid amount as owed for the rest of the month).
    const recovered = resolveBillingState(
      input({ prepaidUsdMicros: 0n, unbilledDebtUsdMicros: 0n }),
    );
    assert.equal(recovered.status, "overage");
    assert.equal(recovered.canSpend, true);
    assert.equal(recovered.reason, null);
    assert.equal(recovered.funding.overage.unbilledDebt?.usd, "0.00");
    assert.equal(recovered.funding.net?.usd, "0.00");
  });

  it("recovers to active immediately on fresh prepaid credit, independent of any debt-read timing", () => {
    // A manual top-up must unblock on its own, in the same read, without
    // waiting on the debt signal to catch up — spendable > 0 short-circuits
    // resolvePosture before unbilledDebt is even considered.
    const state = resolveBillingState(
      input({ prepaidUsdMicros: 10_000_000n, unbilledDebtUsdMicros: 10_000_000n }),
    );
    assert.equal(state.status, "active");
    assert.equal(state.canSpend, true);
    assert.equal(state.funding.spendable.usd, "10.00");
  });
});

describe("resolveBillingState shape", () => {
  it("carries currency on every money field", () => {
    const state = resolveBillingState(input({ currency: "EUR" }));
    assert.equal(state.funding.prepaid.currency, "EUR");
    assert.equal(state.funding.spendable.currency, "EUR");
    assert.equal(state.funding.overage.ceiling.currency, "EUR");
    assert.equal(state.collection.minimumCharge.currency, "EUR");
  });

  it("publishes the collection timing knobs", () => {
    const state = resolveBillingState(input());
    assert.equal(state.collection.cycle, "P1M");
    assert.equal(state.collection.collectionInterval, "P1D");
    assert.equal(state.collection.leadThreshold.usd, "5.00");
    assert.equal(state.collection.minimumCharge.usd, "0.50");
  });

  it("keeps ledger jargon out of customer copy", () => {
    for (const debt of [0n, 5_000_000n, 10_000_000n]) {
      const state = resolveBillingState(
        input({ unbilledDebtUsdMicros: debt }),
      );
      const copy = `${state.explain.headline} ${state.explain.detail}`;
      assert.doesNotMatch(copy, /soft.negative/i);
      assert.doesNotMatch(copy, /micros/i);
      assert.doesNotMatch(copy, /gathering/i);
    }
  });

  it("stamps asOf from the supplied clock", () => {
    const state = resolveBillingState(input());
    assert.equal(state.asOf, "2026-08-08T03:14:00.000Z");
  });

  it("exposes includedUsage with remaining alias", () => {
    const state = resolveBillingState(
      input({
        includedRemainingUsdMicros: 3_000_000n,
        includedTotalUsdMicros: 5_000_000n,
        includedSourcePlan: {
          id: "plan_1",
          name: "Starter",
          type: "free",
        },
        includedResetsAt: "2026-09-01T00:00:00.000Z",
      }),
    );
    assert.equal(state.funding.included.usd, "3.00");
    assert.equal(state.funding.includedUsage.remaining.usd, "3.00");
    assert.equal(state.funding.includedUsage.total.usd, "5.00");
    assert.equal(state.funding.includedUsage.consumed.usd, "2.00");
    assert.equal(state.funding.includedUsage.resetsAt, "2026-09-01T00:00:00.000Z");
    assert.equal(state.funding.includedUsage.sourcePlan?.name, "Starter");
  });
});

describe("explainOverageCeiling", () => {
  it("reads a positive ceiling as a usage allowance", () => {
    assert.equal(
      explainOverageCeiling("2000000"),
      "End users can accrue up to $2.00 of unbilled usage before requests are refused.",
    );
  });

  it("reads a missing ceiling as the $2 default", () => {
    assert.equal(
      explainOverageCeiling(null),
      "End users can accrue up to $2.00 (the default) of unbilled usage before requests are refused.",
    );
  });

  it("reads an explicit zero ceiling as unlimited", () => {
    assert.equal(
      explainOverageCeiling("0"),
      "No overage limit — end users keep spending past their credits as long as usage can be billed.",
    );
  });
});

describe("previewOverageCeiling", () => {
  it("derives the raise point and the buffer it leaves", () => {
    const preview = previewOverageCeiling("10000000");
    assert.equal(preview.error, null);
    assert.match(preview.summary, /up to \$10\.00/);
    assert.match(
      preview.bullets[0],
      /once a user has \$5\.00 of unbilled usage, leaving \$5\.00 of buffer/,
    );
  });

  it("scales the raise point with the ceiling", () => {
    const preview = previewOverageCeiling("2000000");
    assert.match(preview.bullets[0], /\$1\.00 of unbilled usage/);
    assert.match(preview.bullets[0], /\$1\.00 of buffer/);
  });

  it("rejects a ceiling below the collectible floor", () => {
    const preview = previewOverageCeiling("500000");
    assert.match(preview.error ?? "", /at least \$2\.00/);
    assert.deepEqual(preview.bullets, []);
  });

  it("previews a blank field as the $2 default ceiling", () => {
    const preview = previewOverageCeiling(null);
    assert.equal(preview.error, null);
    assert.match(preview.summary, /up to \$2\.00 \(the default\)/);
    assert.match(preview.bullets[0], /\$1\.00 of unbilled usage/);
  });

  it("explains that an explicit 0 means no amount trigger", () => {
    const preview = previewOverageCeiling("0");
    assert.equal(preview.error, null);
    assert.match(preview.bullets[0], /only collected on the recurring sweep/);
  });

  it("always names the minimum charge and the daily sweep", () => {
    for (const value of [null, "0", "2000000", "10000000"]) {
      const preview = previewOverageCeiling(value);
      assert.ok(preview.bullets.some((b) => b.includes("$0.50")));
      assert.ok(preview.bullets.some((b) => b.includes("swept daily")));
    }
  });
});
