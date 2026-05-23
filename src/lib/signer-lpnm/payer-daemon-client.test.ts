import assert from "node:assert/strict";
import { test } from "node:test";

import { buildCreatePaymentRequest } from "./payer-daemon-client";

test("buildCreatePaymentRequest creates quote and funding payload", () => {
  const req = buildCreatePaymentRequest({
    fundedValueWei: 1000n,
    recipient20: Buffer.alloc(20, 7),
    capability: "openai:audio-speech",
    offering: "kokoro",
    ticketParamsBaseUrl: "https://worker.example.com",
    pricePerUnitWei: 1000n,
    unitsPerPrice: 1n,
    estimatedUnits: 12n,
    workUnitName: "work-units",
  });

  assert.equal(req.acceptedPrice.pricePerUnitWei.value.toString("hex"), "03e8");
  assert.equal(req.acceptedPrice.unitsPerPrice, "1");
  assert.equal(req.acceptedPrice.quoteRef.quoteVersion, "1");
  assert.match(req.acceptedPrice.quoteRef.quoteId, /^pymthouse-[0-9a-f]{16}$/);
  assert.equal(req.acceptedPrice.quoteRef.constraintFingerprint.length, 32);
  assert.equal(req.acceptedPrice.quoteRef.routeFingerprint.length, 32);
  assert.equal(req.funding.estimatedUnits, "12");
  assert.equal(req.funding.fundedValueWei.value.toString("hex"), "03e8");
});
