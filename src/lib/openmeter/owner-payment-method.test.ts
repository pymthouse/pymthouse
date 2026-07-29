import assert from "node:assert/strict";
import { test } from "node:test";

import {
  getOwnerDefaultPaymentMethod,
  resolvePreferredCard,
  summarizeStripePaymentMethod,
} from "./owner-payment-method";

type StripeRoute = Record<string, unknown>;

/** Fake Stripe transport keyed by the first matching path fragment. */
function fakeStripe(routes: Record<string, StripeRoute | null>) {
  const calls: string[] = [];
  const fetchImpl = async (input: string) => {
    const path = input.replace("https://api.stripe.com", "");
    calls.push(path);
    const match = Object.keys(routes).find((key) => path.includes(key));
    if (!match || routes[match] === null) {
      return new Response("not found", { status: 404 });
    }
    return new Response(JSON.stringify(routes[match]), { status: 200 });
  };
  return { calls, fetchImpl };
}

function withStripeKey(run: () => Promise<void>): Promise<void> {
  const previous = process.env.STRIPE_SECRET_KEY;
  process.env.STRIPE_SECRET_KEY = "sk_test_fake";
  return run().finally(() => {
    if (previous === undefined) {
      delete process.env.STRIPE_SECRET_KEY;
    } else {
      process.env.STRIPE_SECRET_KEY = previous;
    }
  });
}

const CARD = {
  id: "pm_default",
  card: { brand: "visa", last4: "4242", exp_month: 8, exp_year: 2028 },
};

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

test("resolvePreferredCard uses the expanded customer default in one call", async () => {
  await withStripeKey(async () => {
    const stripe = fakeStripe({
      "/v1/customers/cus_1?": {
        invoice_settings: { default_payment_method: CARD },
      },
    });
    const card = await resolvePreferredCard({
      stripeCustomerId: "cus_1",
      konnectDefaultPaymentMethodId: "pm_default",
      deps: { fetchImpl: stripe.fetchImpl, signal: AbortSignal.timeout(5_000) },
    });
    assert.equal(card?.card?.last4, "4242");
    assert.equal(stripe.calls.length, 1);
  });
});

test("resolvePreferredCard retrieves the Konnect default when Stripe has none", async () => {
  await withStripeKey(async () => {
    const stripe = fakeStripe({
      "/v1/customers/cus_1?": { invoice_settings: {} },
      "/v1/payment_methods/pm_konnect": { ...CARD, id: "pm_konnect" },
    });
    const card = await resolvePreferredCard({
      stripeCustomerId: "cus_1",
      konnectDefaultPaymentMethodId: "pm_konnect",
      deps: { fetchImpl: stripe.fetchImpl, signal: AbortSignal.timeout(5_000) },
    });
    assert.equal(card?.id, "pm_konnect");
  });
});

test("resolvePreferredCard falls back to the card list when no default is on file", async () => {
  await withStripeKey(async () => {
    const stripe = fakeStripe({
      "/v1/customers/cus_1?": { invoice_settings: {} },
      "/payment_methods?type=card": {
        data: [{ id: "pm_no_card" }, { ...CARD, id: "pm_listed" }],
      },
    });
    const card = await resolvePreferredCard({
      stripeCustomerId: "cus_1",
      konnectDefaultPaymentMethodId: null,
      deps: { fetchImpl: stripe.fetchImpl, signal: AbortSignal.timeout(5_000) },
    });
    assert.equal(card?.id, "pm_listed");
  });
});

// The regression: the card list was preferred over the Konnect default, so an
// empty list rendered the "no payment method" state for an owner with a card.
test("resolvePreferredCard prefers the Konnect default over an empty list", async () => {
  await withStripeKey(async () => {
    const stripe = fakeStripe({
      "/v1/customers/cus_1?": { invoice_settings: {} },
      "/v1/payment_methods/pm_konnect": { ...CARD, id: "pm_konnect" },
      "/payment_methods?type=card": { data: [] },
    });
    const card = await resolvePreferredCard({
      stripeCustomerId: "cus_1",
      konnectDefaultPaymentMethodId: "pm_konnect",
      deps: { fetchImpl: stripe.fetchImpl, signal: AbortSignal.timeout(5_000) },
    });
    assert.equal(card?.id, "pm_konnect");
    assert.equal(card?.card?.last4, "4242");
  });
});

test("resolvePreferredCard returns null when Stripe knows no card", async () => {
  await withStripeKey(async () => {
    const stripe = fakeStripe({
      "/v1/customers/cus_1?": { invoice_settings: {} },
      "/payment_methods?type=card": { data: [] },
    });
    const card = await resolvePreferredCard({
      stripeCustomerId: "cus_1",
      konnectDefaultPaymentMethodId: null,
      deps: { fetchImpl: stripe.fetchImpl, signal: AbortSignal.timeout(5_000) },
    });
    assert.equal(card, null);
  });
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
