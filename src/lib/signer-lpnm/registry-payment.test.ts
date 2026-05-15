import assert from "node:assert/strict";
import { test } from "node:test";

import {
  isRegistryPaymentMode,
  parseRegistryFaceValueWei,
  parseRegistryGenerateLivePaymentFields,
  parseRegistryPricePerUnitWei,
} from "./registry-payment";

test("isRegistryPaymentMode accepts paymentMode aliases", () => {
  assert.equal(isRegistryPaymentMode({ paymentMode: "registry" }), true);
  assert.equal(isRegistryPaymentMode({ PaymentMode: "Registry" }), true);
  assert.equal(isRegistryPaymentMode({ paymentMode: "legacy" }), false);
});

test("parseRegistryGenerateLivePaymentFields normalizes recipient and strips ticket URL slash", () => {
  const r = parseRegistryGenerateLivePaymentFields({
    recipient: "0xD00354656922168815FcD1E51CBddb9E359E3C7F",
    ticketParamsBaseUrl: "https://worker.example/",
    capability: "daydream:scope:v1",
    offering: "default",
  });
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.fields.recipient, "0xd00354656922168815fcd1e51cbddb9e359e3c7f");
  assert.equal(r.fields.ticketParamsBaseUrl, "https://worker.example");
  assert.equal(r.fields.capability, "daydream:scope:v1");
  assert.equal(r.fields.offering, "default");
});

test("parseRegistryGenerateLivePaymentFields rejects bad recipient", () => {
  const r = parseRegistryGenerateLivePaymentFields({
    recipient: "0xbad",
    ticketParamsBaseUrl: "https://w",
    capability: "c",
    offering: "o",
  });
  assert.equal(r.ok, false);
});

test("parseRegistryFaceValueWei and parseRegistryPricePerUnitWei", () => {
  assert.equal(parseRegistryFaceValueWei({ faceValueWei: "0" }), undefined);
  assert.equal(parseRegistryFaceValueWei({ face_value_wei: "99" }), 99n);
  assert.equal(parseRegistryPricePerUnitWei({ registryPricePerUnitWei: "5" }), 5n);
});
