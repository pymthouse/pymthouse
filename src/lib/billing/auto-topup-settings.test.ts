import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  DEFAULT_AUTO_TOP_UP_USD_MICROS,
  effectiveAutoTopUpUsdMicros,
  effectiveSoftNegativeUsdMicros,
  isInAutoTopUpLeadWindow,
  parseAutoTopUpUsdMicrosInput,
  parsePositiveUsdMicrosInput,
  parseSoftNegativeUsdMicrosInput,
  softNegativeAllowsContinue,
} from "@/lib/billing/auto-topup-settings";

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
});

describe("parseAutoTopUpUsdMicrosInput", () => {
  it("delegates to positive micros parser", () => {
    assert.deepEqual(parseAutoTopUpUsdMicrosInput("1000000"), {
      ok: true,
      value: "1000000",
    });
    assert.equal(parseAutoTopUpUsdMicrosInput(0).ok, false);
  });
});

describe("effectiveAutoTopUpUsdMicros", () => {
  it("defaults to $5 when unset", () => {
    assert.equal(effectiveAutoTopUpUsdMicros(null), DEFAULT_AUTO_TOP_UP_USD_MICROS);
    assert.equal(effectiveAutoTopUpUsdMicros(""), DEFAULT_AUTO_TOP_UP_USD_MICROS);
  });

  it("uses stored positive micros and falls back on junk", () => {
    assert.equal(effectiveAutoTopUpUsdMicros("10000000"), 10_000_000n);
    assert.equal(effectiveAutoTopUpUsdMicros("0"), DEFAULT_AUTO_TOP_UP_USD_MICROS);
    assert.equal(effectiveAutoTopUpUsdMicros("nope"), DEFAULT_AUTO_TOP_UP_USD_MICROS);
  });
});

describe("effectiveSoftNegativeUsdMicros", () => {
  it("treats unset as 0 (no debt ceiling)", () => {
    assert.equal(effectiveSoftNegativeUsdMicros(null), 0n);
    assert.equal(effectiveSoftNegativeUsdMicros("bad"), 0n);
  });

  it("accepts zero and positive", () => {
    assert.equal(effectiveSoftNegativeUsdMicros("0"), 0n);
    assert.equal(effectiveSoftNegativeUsdMicros("500000"), 500_000n);
  });
});

describe("isInAutoTopUpLeadWindow", () => {
  it("fires in the last autoTopUpAmount of soft-negative headroom", () => {
    assert.equal(
      isInAutoTopUpLeadWindow({
        unbilledDebtUsdMicros: 6_000_000n,
        softNegativeUsdMicros: 10_000_000n,
        autoTopUpUsdMicros: 5_000_000n,
      }),
      true,
    );
    assert.equal(
      isInAutoTopUpLeadWindow({
        unbilledDebtUsdMicros: 4_000_000n,
        softNegativeUsdMicros: 10_000_000n,
        autoTopUpUsdMicros: 5_000_000n,
      }),
      false,
    );
  });

  it("does not fire at or above the hard ceiling or with zero amount", () => {
    assert.equal(
      isInAutoTopUpLeadWindow({
        unbilledDebtUsdMicros: 10_000_000n,
        softNegativeUsdMicros: 10_000_000n,
        autoTopUpUsdMicros: 5_000_000n,
      }),
      false,
    );
    assert.equal(
      isInAutoTopUpLeadWindow({
        unbilledDebtUsdMicros: 0n,
        softNegativeUsdMicros: 10_000_000n,
        autoTopUpUsdMicros: 0n,
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
