import assert from "node:assert/strict";
import { test } from "node:test";
import {
  parseInvoiceThresholdUsdMicrosInput,
  parseProgressiveBillingInput,
} from "./billing-profile-settings";
import { buildKonnectCreateBillingProfileBody } from "./konnect-billing-profiles";

test("parseProgressiveBillingInput accepts booleans only", () => {
  assert.deepEqual(parseProgressiveBillingInput(true), { ok: true, value: true });
  assert.equal(parseProgressiveBillingInput("true").ok, false);
});

test("parseInvoiceThresholdUsdMicrosInput accepts micros or null", () => {
  assert.deepEqual(parseInvoiceThresholdUsdMicrosInput(null), {
    ok: true,
    value: null,
  });
  assert.deepEqual(parseInvoiceThresholdUsdMicrosInput("10000000"), {
    ok: true,
    value: "10000000",
  });
  assert.equal(parseInvoiceThresholdUsdMicrosInput("10.00").ok, false);
});

test("buildKonnectCreateBillingProfileBody includes progressive_billing", () => {
  const body = buildKonnectCreateBillingProfileBody({
    clientId: "app_1",
    stripeAppId: "01G65Z755AFWAKHE12NY0CQ9FH",
    progressiveBilling: false,
  });
  assert.equal(body.workflow.invoicing.progressive_billing, false);
});
