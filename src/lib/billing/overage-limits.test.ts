import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  DEFAULT_SOFT_NEGATIVE_USD_MICROS,
  effectiveInvoiceLeadUsdMicros,
  effectiveSoftNegativeUsdMicros,
  isInInvoiceTriggerLeadWindow,
  MAX_INVOICE_TRIGGER_LEAD_USD_MICROS,
  MIN_SOFT_NEGATIVE_USD_MICROS,
  parsePositiveUsdMicrosInput,
  parseSoftNegativeUsdMicrosInput,
  softNegativeAllowsContinue,
} from "@/lib/billing/overage-limits";

describe("parsePositiveUsdMicrosInput", () => {
  it("accepts null, empty, number, and digit strings", () => {
    assert.deepEqual(parsePositiveUsdMicrosInput(null, "x"), {
      ok: true,
      value: null,
    });
    assert.deepEqual(parsePositiveUsdMicrosInput("", "x"), {
      ok: true,
      value: null,
    });
    assert.deepEqual(parsePositiveUsdMicrosInput("  ", "x"), {
      ok: true,
      value: null,
    });
    assert.deepEqual(parsePositiveUsdMicrosInput(5_000_000, "x"), {
      ok: true,
      value: "5000000",
    });
    assert.deepEqual(parsePositiveUsdMicrosInput("2500000", "x"), {
      ok: true,
      value: "2500000",
    });
  });

  it("rejects non-positive and non-integer values", () => {
    assert.equal(parsePositiveUsdMicrosInput(0, "x").ok, false);
    assert.equal(parsePositiveUsdMicrosInput(-1, "x").ok, false);
    assert.equal(parsePositiveUsdMicrosInput(1.5, "x").ok, false);
    assert.equal(parsePositiveUsdMicrosInput("0", "x").ok, false);
    assert.equal(parsePositiveUsdMicrosInput("abc", "x").ok, false);
    assert.equal(parsePositiveUsdMicrosInput(true, "x").ok, false);
  });
});

describe("parseSoftNegativeUsdMicrosInput", () => {
  it("allows zero and clears blank", () => {
    assert.deepEqual(parseSoftNegativeUsdMicrosInput(null), {
      ok: true,
      value: null,
    });
    assert.deepEqual(parseSoftNegativeUsdMicrosInput(0), {
      ok: true,
      value: "0",
    });
    assert.deepEqual(parseSoftNegativeUsdMicrosInput("0"), {
      ok: true,
      value: "0",
    });
    assert.deepEqual(parseSoftNegativeUsdMicrosInput("7500000"), {
      ok: true,
      value: "7500000",
    });
  });

  it("rejects negatives and garbage", () => {
    assert.equal(parseSoftNegativeUsdMicrosInput(-1).ok, false);
    assert.equal(parseSoftNegativeUsdMicrosInput(1.2).ok, false);
    assert.equal(parseSoftNegativeUsdMicrosInput("nope").ok, false);
    assert.equal(parseSoftNegativeUsdMicrosInput({}).ok, false);
  });

  it("rejects positive ceilings below the collectable floor", () => {
    // $0.50 equals Stripe's minimum charge, leaving no headroom to collect
    // before the gate denies.
    assert.equal(parseSoftNegativeUsdMicrosInput("500000").ok, false);
    assert.equal(parseSoftNegativeUsdMicrosInput(1_999_999).ok, false);
    assert.deepEqual(
      parseSoftNegativeUsdMicrosInput(String(MIN_SOFT_NEGATIVE_USD_MICROS)),
      { ok: true, value: "2000000" },
    );
  });
});

describe("effectiveInvoiceLeadUsdMicros", () => {
  it("derives half the ceiling, capped at the max", () => {
    assert.equal(
      effectiveInvoiceLeadUsdMicros({
        storedUsdMicros: null,
        softNegativeUsdMicros: 2_000_000n,
      }),
      1_000_000n,
    );
    assert.equal(
      effectiveInvoiceLeadUsdMicros({
        storedUsdMicros: null,
        softNegativeUsdMicros: 100_000_000n,
      }),
      MAX_INVOICE_TRIGGER_LEAD_USD_MICROS,
    );
  });

  it("falls back to the max when no ceiling is configured", () => {
    assert.equal(
      effectiveInvoiceLeadUsdMicros({
        storedUsdMicros: null,
        softNegativeUsdMicros: 0n,
      }),
      MAX_INVOICE_TRIGGER_LEAD_USD_MICROS,
    );
  });

  it("prefers a stored positive override", () => {
    assert.equal(
      effectiveInvoiceLeadUsdMicros({
        storedUsdMicros: "750000",
        softNegativeUsdMicros: 10_000_000n,
      }),
      750_000n,
    );
    assert.equal(
      effectiveInvoiceLeadUsdMicros({
        storedUsdMicros: "garbage",
        softNegativeUsdMicros: 10_000_000n,
      }),
      MAX_INVOICE_TRIGGER_LEAD_USD_MICROS,
    );
  });
});

describe("effectiveSoftNegativeUsdMicros", () => {
  it("defaults unset and invalid to the $2 ceiling", () => {
    assert.equal(
      effectiveSoftNegativeUsdMicros(null),
      DEFAULT_SOFT_NEGATIVE_USD_MICROS,
    );
    assert.equal(
      effectiveSoftNegativeUsdMicros(""),
      DEFAULT_SOFT_NEGATIVE_USD_MICROS,
    );
    assert.equal(
      effectiveSoftNegativeUsdMicros("bad"),
      DEFAULT_SOFT_NEGATIVE_USD_MICROS,
    );
    assert.equal(
      effectiveSoftNegativeUsdMicros("-1"),
      DEFAULT_SOFT_NEGATIVE_USD_MICROS,
    );
  });

  it("treats an explicit 0 as opting out of the ceiling", () => {
    assert.equal(effectiveSoftNegativeUsdMicros("0"), 0n);
  });

  it("passes through a stored positive ceiling", () => {
    assert.equal(effectiveSoftNegativeUsdMicros("500000"), 500_000n);
  });
});

describe("isInInvoiceTriggerLeadWindow", () => {
  it("fires in the last leadUsdMicros of soft-negative headroom", () => {
    assert.equal(
      isInInvoiceTriggerLeadWindow({
        unbilledDebtUsdMicros: 6_000_000n,
        softNegativeUsdMicros: 10_000_000n,
        leadUsdMicros: MAX_INVOICE_TRIGGER_LEAD_USD_MICROS,
      }),
      true,
    );
    assert.equal(
      isInInvoiceTriggerLeadWindow({
        unbilledDebtUsdMicros: 4_000_000n,
        softNegativeUsdMicros: 10_000_000n,
        leadUsdMicros: MAX_INVOICE_TRIGGER_LEAD_USD_MICROS,
      }),
      false,
    );
  });

  it("does not fire at or above the hard ceiling or with zero lead", () => {
    assert.equal(
      isInInvoiceTriggerLeadWindow({
        unbilledDebtUsdMicros: 10_000_000n,
        softNegativeUsdMicros: 10_000_000n,
        leadUsdMicros: MAX_INVOICE_TRIGGER_LEAD_USD_MICROS,
      }),
      false,
    );
    assert.equal(
      isInInvoiceTriggerLeadWindow({
        unbilledDebtUsdMicros: 0n,
        softNegativeUsdMicros: 10_000_000n,
        leadUsdMicros: 0n,
      }),
      false,
    );
  });
});

describe("softNegativeAllowsContinue", () => {
  it("allows positive spendable regardless of debt", () => {
    assert.equal(
      softNegativeAllowsContinue({
        spendableUsdMicros: 1n,
        allowsOverageInvoicing: false,
        unbilledDebtUsdMicros: 99n,
        softNegativeUsdMicros: 0n,
      }),
      true,
    );
  });

  it("allows overage past prepaid zero when soft-negative ceiling is unset", () => {
    assert.equal(
      softNegativeAllowsContinue({
        spendableUsdMicros: 0n,
        allowsOverageInvoicing: true,
        unbilledDebtUsdMicros: 0n,
        softNegativeUsdMicros: 0n,
      }),
      true,
    );
    assert.equal(
      softNegativeAllowsContinue({
        spendableUsdMicros: 0n,
        allowsOverageInvoicing: true,
        unbilledDebtUsdMicros: 9_999_999n,
        softNegativeUsdMicros: 0n,
      }),
      true,
    );
  });

  it("requires overage and debt below soft-negative at zero spendable", () => {
    assert.equal(
      softNegativeAllowsContinue({
        spendableUsdMicros: 0n,
        allowsOverageInvoicing: true,
        unbilledDebtUsdMicros: 100n,
        softNegativeUsdMicros: 500n,
      }),
      true,
    );
    assert.equal(
      softNegativeAllowsContinue({
        spendableUsdMicros: 0n,
        allowsOverageInvoicing: true,
        unbilledDebtUsdMicros: 500n,
        softNegativeUsdMicros: 500n,
      }),
      false,
    );
    assert.equal(
      softNegativeAllowsContinue({
        spendableUsdMicros: 0n,
        allowsOverageInvoicing: false,
        unbilledDebtUsdMicros: 0n,
        softNegativeUsdMicros: 500n,
      }),
      false,
    );
  });
});
