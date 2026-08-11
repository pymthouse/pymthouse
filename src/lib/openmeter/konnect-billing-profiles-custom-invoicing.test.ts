import test from "node:test";
import assert from "node:assert/strict";
import {
  buildKonnectMerchantCustomInvoicingProfileBody,
  isKonnectCustomInvoicingApp,
  selectKonnectCustomInvoicingApp,
} from "./konnect-billing-profiles";

test("isKonnectCustomInvoicingApp matches custom_invoicing type", () => {
  assert.equal(
    isKonnectCustomInvoicingApp({ id: "1", type: "custom_invoicing" }),
    true,
  );
  assert.equal(
    isKonnectCustomInvoicingApp({
      id: "1",
      definition: { type: "custom_invoicing" },
    }),
    true,
  );
  assert.equal(isKonnectCustomInvoicingApp({ id: "1", type: "stripe" }), false);
});

test("selectKonnectCustomInvoicingApp prefers ready and skips unauthorized", () => {
  assert.equal(
    selectKonnectCustomInvoicingApp([
      { id: "stripe1", type: "stripe", status: "ready" },
      { id: "ci1", type: "custom_invoicing", status: "ready" },
    ]),
    "ci1",
  );
  assert.equal(
    selectKonnectCustomInvoicingApp([
      { id: "bad", type: "custom_invoicing", status: "unauthorized" },
      { id: "ok", type: "custom_invoicing", status: "ready" },
    ]),
    "ok",
  );
  assert.equal(
    selectKonnectCustomInvoicingApp([
      { id: "bad", type: "custom_invoicing", status: "unauthorized" },
      { id: "fallback", type: "custom_invoicing" },
    ]),
    "fallback",
  );
  assert.equal(selectKonnectCustomInvoicingApp([{ id: "s", type: "stripe" }]), null);
  assert.equal(
    selectKonnectCustomInvoicingApp([
      { id: "bad", type: "custom_invoicing", status: "unauthorized" },
    ]),
    null,
  );
});

test("buildKonnectMerchantCustomInvoicingProfileBody pins all slots to CI app", () => {
  const body = buildKonnectMerchantCustomInvoicingProfileBody({
    customInvoicingAppId: "ci_app_1",
    name: "pymthouse-merchant-custom-invoicing",
  });
  assert.equal(body.default, false);
  assert.equal(body.apps.tax.id, "ci_app_1");
  assert.equal(body.apps.invoicing.id, "ci_app_1");
  assert.equal(body.apps.payment.id, "ci_app_1");
  assert.equal(body.workflow.payment.collection_method, "charge_automatically");
});
