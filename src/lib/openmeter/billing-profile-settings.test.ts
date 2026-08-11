import assert from "node:assert/strict";
import { test } from "node:test";
import {
  parseInvoiceLeadUsdMicrosInput,
  parseProgressiveBillingInput,
} from "./billing-profile-settings";
import { buildKonnectCreateBillingProfileBody } from "./konnect-billing-profiles";

test("parseProgressiveBillingInput accepts booleans only", () => {
  assert.deepEqual(parseProgressiveBillingInput(true), { ok: true, value: true });
  assert.equal(parseProgressiveBillingInput("true").ok, false);
});

test("parseInvoiceLeadUsdMicrosInput accepts positive micros or null", () => {
  assert.deepEqual(parseInvoiceLeadUsdMicrosInput(null), {
    ok: true,
    value: null,
  });
  assert.deepEqual(parseInvoiceLeadUsdMicrosInput("10000000"), {
    ok: true,
    value: "10000000",
  });
  assert.equal(parseInvoiceLeadUsdMicrosInput("10.00").ok, false);
  assert.equal(parseInvoiceLeadUsdMicrosInput("0").ok, false);
});

test("buildKonnectCreateBillingProfileBody includes progressive_billing", () => {
  const body = buildKonnectCreateBillingProfileBody({
    clientId: "app_1",
    stripeAppId: "01G65Z755AFWAKHE12NY0CQ9FH",
    progressiveBilling: false,
  });
  assert.equal(body.workflow.invoicing.progressive_billing, false);
});

test("buildKonnectCreateBillingProfileBody anchors daily collection", () => {
  const anchor = new Date("2026-03-04T05:06:07.000Z");
  const body = buildKonnectCreateBillingProfileBody({
    clientId: "app_1",
    stripeAppId: "01G65Z755AFWAKHE12NY0CQ9FH",
    collectionAnchor: anchor,
  });
  assert.deepEqual(body.workflow.collection, {
    alignment: {
      type: "anchored",
      recurring_period: {
        interval: "P1D",
        anchor: "2026-03-04T05:06:07.000Z",
      },
    },
  });
});
