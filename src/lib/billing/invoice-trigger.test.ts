import assert from "node:assert/strict";
import test from "node:test";

import { MIN_INVOICE_USD_MICROS } from "@/lib/billing/auto-topup-settings";
import {
  __resetInvoiceTriggerCacheForTests,
  __testInvoiceTrigger,
  invoiceGatheringForIdentity,
} from "@/lib/billing/invoice-trigger";

test("shouldTriggerInvoice will not raise below Stripe's minimum charge", () => {
  // An invoice under $0.50 cannot be collected, so raising it only parks a
  // draft. OM's daily collection alignment picks these up instead.
  assert.equal(
    __testInvoiceTrigger.shouldTriggerInvoice({
      unbilledDebtUsdMicros: 10_000n,
      softNegativeUsdMicros: 0n,
      leadUsdMicros: 5_000_000n,
    }),
    false,
  );
  assert.equal(
    __testInvoiceTrigger.shouldTriggerInvoice({
      unbilledDebtUsdMicros: 499_999n,
      softNegativeUsdMicros: 0n,
      leadUsdMicros: 5_000_000n,
    }),
    false,
  );
  assert.equal(
    __testInvoiceTrigger.shouldTriggerInvoice({
      unbilledDebtUsdMicros: MIN_INVOICE_USD_MICROS,
      softNegativeUsdMicros: 0n,
      leadUsdMicros: 5_000_000n,
    }),
    true,
  );
});

test("shouldTriggerInvoice fires any collectable debt when soft-negative unset", () => {
  assert.equal(
    __testInvoiceTrigger.shouldTriggerInvoice({
      unbilledDebtUsdMicros: 900_000n,
      softNegativeUsdMicros: 0n,
      leadUsdMicros: 5_000_000n,
    }),
    true,
  );
});

test("shouldTriggerInvoice uses lead window when soft-negative is set", () => {
  // Ceiling $10, lead $5 → fire at $5–$9.999…
  assert.equal(
    __testInvoiceTrigger.shouldTriggerInvoice({
      unbilledDebtUsdMicros: 4_999_999n,
      softNegativeUsdMicros: 10_000_000n,
      leadUsdMicros: 5_000_000n,
    }),
    false,
  );
  assert.equal(
    __testInvoiceTrigger.shouldTriggerInvoice({
      unbilledDebtUsdMicros: 5_000_000n,
      softNegativeUsdMicros: 10_000_000n,
      leadUsdMicros: 5_000_000n,
    }),
    true,
  );
  assert.equal(
    __testInvoiceTrigger.shouldTriggerInvoice({
      unbilledDebtUsdMicros: 9_999_999n,
      softNegativeUsdMicros: 10_000_000n,
      leadUsdMicros: 5_000_000n,
    }),
    true,
  );
  // At/above ceiling the gate denies; trigger should not fire either.
  assert.equal(
    __testInvoiceTrigger.shouldTriggerInvoice({
      unbilledDebtUsdMicros: 10_000_000n,
      softNegativeUsdMicros: 10_000_000n,
      leadUsdMicros: 5_000_000n,
    }),
    false,
  );
});

test("shouldTriggerInvoice at the $2 minimum ceiling raises at $1", () => {
  // The tightest ceiling we allow still leaves a collectable window: $1 of
  // debt is above Stripe's floor and $1 below the deny line.
  assert.equal(
    __testInvoiceTrigger.shouldTriggerInvoice({
      unbilledDebtUsdMicros: 999_999n,
      softNegativeUsdMicros: 2_000_000n,
      leadUsdMicros: 1_000_000n,
    }),
    false,
  );
  assert.equal(
    __testInvoiceTrigger.shouldTriggerInvoice({
      unbilledDebtUsdMicros: 1_000_000n,
      softNegativeUsdMicros: 2_000_000n,
      leadUsdMicros: 1_000_000n,
    }),
    true,
  );
});

test("invoiceGatheringForIdentity returns unavailable without OpenMeter", async (t) => {
  __resetInvoiceTriggerCacheForTests();
  const prevUrl = process.env.OPENMETER_URL;
  const prevKey = process.env.OPENMETER_API_KEY;
  t.after(() => {
    __resetInvoiceTriggerCacheForTests();
    if (prevUrl === undefined) delete process.env.OPENMETER_URL;
    else process.env.OPENMETER_URL = prevUrl;
    if (prevKey === undefined) delete process.env.OPENMETER_API_KEY;
    else process.env.OPENMETER_API_KEY = prevKey;
  });
  delete process.env.OPENMETER_URL;
  delete process.env.OPENMETER_API_KEY;

  assert.deepEqual(
    await invoiceGatheringForIdentity({
      clientId: "app_invoice_trigger",
      externalUserId: "eu_1",
    }),
    { outcome: "unavailable", invoiceIds: [] },
  );
});

test("invoiceGatheringForIdentity skips blank ids", async () => {
  __resetInvoiceTriggerCacheForTests();
  assert.deepEqual(
    await invoiceGatheringForIdentity({
      clientId: "  ",
      externalUserId: "eu_1",
    }),
    { outcome: "skipped", invoiceIds: [] },
  );
  assert.deepEqual(
    await invoiceGatheringForIdentity({
      clientId: "app_invoice_trigger",
      externalUserId: "",
    }),
    { outcome: "skipped", invoiceIds: [] },
  );
});
