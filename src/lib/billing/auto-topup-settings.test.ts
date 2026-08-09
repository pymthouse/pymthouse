import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  DEFAULT_AUTO_TOP_UP_USD_MICROS,
  effectiveAutoTopUpUsdMicros,
  effectiveSoftNegativeUsdMicros,
  isInAutoTopUpLeadWindow,
  softNegativeAllowsContinue,
} from "@/lib/billing/auto-topup-settings";

describe("effectiveAutoTopUpUsdMicros", () => {
  it("defaults to $5 when unset", () => {
    assert.equal(effectiveAutoTopUpUsdMicros(null), DEFAULT_AUTO_TOP_UP_USD_MICROS);
    assert.equal(effectiveAutoTopUpUsdMicros(""), DEFAULT_AUTO_TOP_UP_USD_MICROS);
  });

  it("uses stored positive micros", () => {
    assert.equal(effectiveAutoTopUpUsdMicros("10000000"), 10_000_000n);
  });
});

describe("effectiveSoftNegativeUsdMicros", () => {
  it("treats unset as 0", () => {
    assert.equal(effectiveSoftNegativeUsdMicros(null), 0n);
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

  it("does not fire at or above the hard ceiling", () => {
    assert.equal(
      isInAutoTopUpLeadWindow({
        unbilledDebtUsdMicros: 10_000_000n,
        softNegativeUsdMicros: 10_000_000n,
        autoTopUpUsdMicros: 5_000_000n,
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
