import assert from "node:assert/strict";
import { test } from "node:test";

import {
  getOwnerDefaultPaymentMethod,
  summarizeStripePaymentMethod,
} from "./owner-payment-method";

test("summarizeStripePaymentMethod maps card fields", () => {
  assert.deepEqual(
    summarizeStripePaymentMethod({
      id: "pm_1",
      card: {
        brand: "visa",
        last4: "4242",
        exp_month: 8,
        exp_year: 2028,
      },
    }),
    {
      id: "pm_1",
      brand: "visa",
      last4: "4242",
      expMonth: 8,
      expYear: 2028,
    },
  );
});

test("summarizeStripePaymentMethod returns null without id", () => {
  assert.equal(summarizeStripePaymentMethod({ card: { last4: "4242" } }), null);
});

test("getOwnerDefaultPaymentMethod returns null without Stripe key", async () => {
  const previousSecret = process.env.STRIPE_SECRET_KEY;
  const previousApi = process.env.STRIPE_API_KEY;
  delete process.env.STRIPE_SECRET_KEY;
  delete process.env.STRIPE_API_KEY;
  try {
    assert.equal(await getOwnerDefaultPaymentMethod("user_1"), null);
  } finally {
    if (previousSecret === undefined) {
      delete process.env.STRIPE_SECRET_KEY;
    } else {
      process.env.STRIPE_SECRET_KEY = previousSecret;
    }
    if (previousApi === undefined) {
      delete process.env.STRIPE_API_KEY;
    } else {
      process.env.STRIPE_API_KEY = previousApi;
    }
  }
});
