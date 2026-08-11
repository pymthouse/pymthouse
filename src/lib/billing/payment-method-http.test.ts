import assert from "node:assert/strict";
import test from "node:test";

import {
  paymentMethodCheckoutErrorStatus,
  paymentMethodCheckoutErrorResponse,
  paymentMethodDefaultErrorResponse,
  paymentMethodUnlinkErrorResponse,
} from "./payment-method-http";

test("paymentMethodCheckoutErrorStatus maps known messages", () => {
  assert.equal(paymentMethodCheckoutErrorStatus("STRIPE_SECRET_KEY missing"), 400);
  assert.equal(paymentMethodCheckoutErrorStatus("OPENMETER_URL required"), 400);
  assert.equal(paymentMethodCheckoutErrorStatus("No ready Stripe app"), 400);
  assert.equal(
    paymentMethodCheckoutErrorStatus(
      "Merchant Stripe Connect onboarding is required before adding a payment method",
    ),
    403,
  );
  assert.equal(paymentMethodCheckoutErrorStatus("Cannot reach OpenMeter"), 503);
  assert.equal(paymentMethodCheckoutErrorStatus("boom"), 502);
});

test("payment-method HTTP helpers return JSON error bodies", async () => {
  const checkout = paymentMethodCheckoutErrorResponse(
    new Error("Cannot reach OpenMeter"),
  );
  assert.equal(checkout.status, 503);
  assert.deepEqual(await checkout.json(), {
    error: "Cannot reach OpenMeter",
  });

  const def = paymentMethodDefaultErrorResponse(new Error("stripe down"));
  assert.equal(def.status, 502);

  const unlinkVerify = paymentMethodUnlinkErrorResponse(
    new Error("Unable to verify payment methods right now"),
  );
  assert.equal(unlinkVerify.status, 503);

  const unlinkLast = paymentMethodUnlinkErrorResponse(
    new Error("This is your only payment method"),
  );
  assert.equal(unlinkLast.status, 409);

  const unlinkOther = paymentMethodUnlinkErrorResponse(new Error("other"));
  assert.equal(unlinkOther.status, 502);
});
