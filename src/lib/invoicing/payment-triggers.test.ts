import test from "node:test";
import assert from "node:assert/strict";
import { paymentTriggerFromStripeEvent } from "./state-machine";

test("maps Stripe payment events to Custom Invoicing triggers", () => {
  assert.equal(paymentTriggerFromStripeEvent("payment_intent.succeeded"), "paid");
  assert.equal(
    paymentTriggerFromStripeEvent("payment_intent.payment_failed"),
    "payment_failed",
  );
  assert.equal(
    paymentTriggerFromStripeEvent("payment_intent.requires_action"),
    "action_required",
  );
  assert.equal(
    paymentTriggerFromStripeEvent("charge.dispute.created"),
    "payment_uncollectible",
  );
  assert.equal(paymentTriggerFromStripeEvent("invoice.paid"), null);
});
