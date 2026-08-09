import assert from "node:assert/strict";
import test from "node:test";

import {
  __resetInvoiceTriggerCacheForTests,
  __testInvoiceTrigger,
  maybeInvoiceGatheringForIdentity,
} from "@/lib/billing/invoice-trigger";

test("shouldTriggerInvoice requires positive debt", () => {
  assert.equal(
    __testInvoiceTrigger.shouldTriggerInvoice({
      unbilledDebtUsdMicros: 0n,
      softNegativeUsdMicros: 10_000_000n,
    }),
    false,
  );
  assert.equal(
    __testInvoiceTrigger.shouldTriggerInvoice({
      unbilledDebtUsdMicros: -1n,
      softNegativeUsdMicros: 0n,
    }),
    false,
  );
});

test("shouldTriggerInvoice fires any positive debt when soft-negative unset", () => {
  assert.equal(
    __testInvoiceTrigger.shouldTriggerInvoice({
      unbilledDebtUsdMicros: 1n,
      softNegativeUsdMicros: 0n,
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
    }),
    false,
  );
  assert.equal(
    __testInvoiceTrigger.shouldTriggerInvoice({
      unbilledDebtUsdMicros: 5_000_000n,
      softNegativeUsdMicros: 10_000_000n,
    }),
    true,
  );
  assert.equal(
    __testInvoiceTrigger.shouldTriggerInvoice({
      unbilledDebtUsdMicros: 9_999_999n,
      softNegativeUsdMicros: 10_000_000n,
    }),
    true,
  );
  // At/above ceiling the gate denies; trigger should not fire either.
  assert.equal(
    __testInvoiceTrigger.shouldTriggerInvoice({
      unbilledDebtUsdMicros: 10_000_000n,
      softNegativeUsdMicros: 10_000_000n,
    }),
    false,
  );
});

test("maybeInvoiceGatheringForIdentity returns unavailable without OpenMeter", async (t) => {
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

  assert.equal(
    await maybeInvoiceGatheringForIdentity({
      clientId: "app_invoice_trigger",
      externalUserId: "eu_1",
    }),
    "unavailable",
  );
});

test("maybeInvoiceGatheringForIdentity skips blank ids", async () => {
  __resetInvoiceTriggerCacheForTests();
  assert.equal(
    await maybeInvoiceGatheringForIdentity({
      clientId: "  ",
      externalUserId: "eu_1",
    }),
    "skipped",
  );
  assert.equal(
    await maybeInvoiceGatheringForIdentity({
      clientId: "app_invoice_trigger",
      externalUserId: "",
    }),
    "skipped",
  );
});
