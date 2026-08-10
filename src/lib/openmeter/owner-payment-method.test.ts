import assert from "node:assert/strict";
import { test } from "node:test";

import {
  buildOwnerPaymentMethodList,
  collapseDuplicateLinkMethods,
  listOwnerPaymentMethods,
  resolveOwnerBillingCheckoutReturnUrl,
  setStripeCustomerDefaultPaymentMethod,
  toOwnerPaymentMethodItem,
  toStripeApiUrl,
  unlinkStripeCustomerPaymentMethod,
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
  id: "pm_card",
  type: "card",
  card: { brand: "visa", last4: "4242", exp_month: 8, exp_year: 2028 },
};

/** Checkout attaches these with no card object; the funding card lives in Link. */
const LINK = { id: "pm_link", type: "link", link: { email: "o@example.test" } };

const BANK = {
  id: "pm_bank",
  type: "us_bank_account",
  us_bank_account: { bank_name: "Chase", last4: "6789" },
};

test("toOwnerPaymentMethodItem maps card fields", () => {
  assert.deepEqual(toOwnerPaymentMethodItem(CARD, "pm_card"), {
    id: "pm_card",
    type: "card",
    brand: "visa",
    last4: "4242",
    expMonth: 8,
    expYear: 2028,
    isDefault: true,
  });
});

test("toStripeApiUrl accepts relative /v1 paths on api.stripe.com", () => {
  assert.equal(
    toStripeApiUrl("/v1/customers/cus_abc/payment_methods?limit=100"),
    "https://api.stripe.com/v1/customers/cus_abc/payment_methods?limit=100",
  );
});

test("toStripeApiUrl rejects absolute or non-/v1 paths", () => {
  assert.throws(() => toStripeApiUrl("https://evil.example/v1/customers"));
  assert.throws(() => toStripeApiUrl("/v2/customers"));
  assert.throws(() => toStripeApiUrl("/v1/../admin"));
});

test("toOwnerPaymentMethodItem labels Link as brand-only (no last4 from Stripe)", () => {
  assert.deepEqual(toOwnerPaymentMethodItem(LINK, null), {
    id: "pm_link",
    type: "link",
    brand: "link",
    last4: null,
    expMonth: null,
    expYear: null,
    isDefault: false,
  });
});

test("toOwnerPaymentMethodItem labels a bank account with bank name and last4", () => {
  assert.deepEqual(toOwnerPaymentMethodItem(BANK, null), {
    id: "pm_bank",
    type: "us_bank_account",
    brand: "Chase",
    last4: "6789",
    expMonth: null,
    expYear: null,
    isDefault: false,
  });
});

test("toOwnerPaymentMethodItem returns null without id", () => {
  assert.equal(toOwnerPaymentMethodItem({ card: { last4: "4242" } }, null), null);
});

test("collapseDuplicateLinkMethods keeps the default Link and orphans the rest", () => {
  const { kept, orphanLinkIds } = collapseDuplicateLinkMethods([
    {
      id: "pm_link_a",
      type: "link",
      brand: "link",
      last4: null,
      expMonth: null,
      expYear: null,
      isDefault: false,
    },
    {
      id: "pm_link_b",
      type: "link",
      brand: "link",
      last4: null,
      expMonth: null,
      expYear: null,
      isDefault: true,
    },
    {
      id: "pm_card",
      type: "card",
      brand: "visa",
      last4: "4242",
      expMonth: 8,
      expYear: 2028,
      isDefault: false,
    },
  ]);
  assert.deepEqual(
    kept.map((item) => item.id),
    ["pm_link_b", "pm_card"],
  );
  assert.deepEqual(orphanLinkIds, ["pm_link_a"]);
});

test("buildOwnerPaymentMethodList collapses duplicate Links to one", async () => {
  await withStripeKey(async () => {
    const duplicateLink = { ...LINK, id: "pm_link_2" };
    const stripe = fakeStripe({
      "/payment_methods?limit=100": { data: [LINK, duplicateLink, CARD] },
      "/v1/customers/cus_1": { invoice_settings: {} },
    });
    const { items, orphanLinkIds } = await buildOwnerPaymentMethodList({
      stripeCustomerId: "cus_1",
      konnectDefaultPaymentMethodId: null,
      deps: { fetchImpl: stripe.fetchImpl, signal: AbortSignal.timeout(5_000) },
    });
    assert.deepEqual(
      items.map((item) => item.id),
      ["pm_link", "pm_card"],
    );
    assert.deepEqual(orphanLinkIds, ["pm_link_2"]);
  });
});

test("buildOwnerPaymentMethodList flags Stripe's invoice default", async () => {
  await withStripeKey(async () => {
    const stripe = fakeStripe({
      "/payment_methods?limit=100": { data: [LINK, CARD] },
      "/v1/customers/cus_1": {
        invoice_settings: { default_payment_method: "pm_card" },
      },
    });
    const { items } = await buildOwnerPaymentMethodList({
      stripeCustomerId: "cus_1",
      konnectDefaultPaymentMethodId: "pm_link",
      deps: { fetchImpl: stripe.fetchImpl, signal: AbortSignal.timeout(5_000) },
    });
    assert.deepEqual(
      items.filter((item) => item.isDefault).map((item) => item.id),
      ["pm_card"],
    );
    // Default leads even when Stripe returned Link first.
    assert.equal(items[0]?.id, "pm_card");
  });
});

test("attached payment methods are not chargeable without a Stripe/Konnect default", async () => {
  // Regression: Checkout can attach a card while invoice_settings.default_payment_method
  // stays empty. Gate chargeability must require a default — not items.length > 0.
  await withStripeKey(async () => {
    const stripe = fakeStripe({
      "/payment_methods?limit=100": { data: [CARD, LINK] },
      "/v1/customers/cus_attached": { invoice_settings: {} },
    });
    const { items } = await buildOwnerPaymentMethodList({
      stripeCustomerId: "cus_attached",
      konnectDefaultPaymentMethodId: null,
      deps: { fetchImpl: stripe.fetchImpl, signal: AbortSignal.timeout(5_000) },
    });
    assert.equal(items.length > 0, true);
    assert.equal(
      items.some((pm) => pm.isDefault),
      false,
      "attached-but-not-default must not unlock charge_automatically",
    );
  });
});

test("buildOwnerPaymentMethodList lists merchant customer methods on its Connected Account", async () => {
  await withStripeKey(async () => {
    const stripeAccounts: string[] = [];
    const fetchImpl = async (
      _input: string,
      init?: RequestInit,
    ): Promise<Response> => {
      const headers = new Headers(init?.headers);
      stripeAccounts.push(headers.get("Stripe-Account") ?? "");
      if (_input.includes("/payment_methods?limit=100")) {
        return Response.json({ data: [CARD] });
      }
      return Response.json({ invoice_settings: {} });
    };

    const { items } = await buildOwnerPaymentMethodList({
      stripeCustomerId: "cus_connected",
      konnectDefaultPaymentMethodId: null,
      deps: {
        fetchImpl,
        signal: AbortSignal.timeout(5_000),
        stripeAccount: "acct_merchant",
      },
    });

    assert.deepEqual(
      items.map((item) => ({ id: item.id, isDefault: item.isDefault })),
      [{ id: "pm_card", isDefault: false }],
      "attached-only Connect cards must not fake a Stripe invoice default",
    );
    assert.deepEqual(stripeAccounts, ["acct_merchant", "acct_merchant"]);
  });
});

test("setStripeCustomerDefaultPaymentMethod updates a connected customer", async (t) => {
  const previousFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = previousFetch;
  });
  const requests: Array<{ path: string; stripeAccount: string | null; body: string }> =
    [];
  globalThis.fetch = async (input, init) => {
    const headers = new Headers(init?.headers);
    requests.push({
      path: String(input),
      stripeAccount: headers.get("Stripe-Account"),
      body: String(init?.body ?? ""),
    });
    if (String(input).includes("/payment_methods/pm_card")) {
      return Response.json({ ...CARD, customer: "cus_connected" });
    }
    return Response.json({ id: "cus_connected" });
  };
  const previousKey = process.env.STRIPE_SECRET_KEY;
  process.env.STRIPE_SECRET_KEY = "sk_test_fake";
  t.after(() => {
    if (previousKey === undefined) delete process.env.STRIPE_SECRET_KEY;
    else process.env.STRIPE_SECRET_KEY = previousKey;
  });

  const result = await setStripeCustomerDefaultPaymentMethod({
    stripeCustomerId: "cus_connected",
    paymentMethodId: "pm_card",
    stripeAccount: "acct_merchant",
  });

  assert.deepEqual(result, { updated: true, paymentMethodId: "pm_card" });
  assert.equal(requests[0]?.stripeAccount, "acct_merchant");
  assert.match(
    requests[1]?.body ?? "",
    /invoice_settings%5Bdefault_payment_method%5D=pm_card/,
  );
});

test("unlinkStripeCustomerPaymentMethod refuses the only attached method", async (t) => {
  const previousFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = previousFetch;
  });
  globalThis.fetch = async (input) => {
    const url = String(input);
    if (url.includes("/payment_methods?limit=100")) {
      return Response.json({ data: [CARD] });
    }
    if (url.includes("/payment_methods/pm_card")) {
      return Response.json({ ...CARD, customer: "cus_connected" });
    }
    return Response.json({ invoice_settings: {} });
  };
  const previousKey = process.env.STRIPE_SECRET_KEY;
  process.env.STRIPE_SECRET_KEY = "sk_test_fake";
  t.after(() => {
    if (previousKey === undefined) delete process.env.STRIPE_SECRET_KEY;
    else process.env.STRIPE_SECRET_KEY = previousKey;
  });

  await assert.rejects(
    unlinkStripeCustomerPaymentMethod({
      stripeCustomerId: "cus_connected",
      paymentMethodId: "pm_card",
      stripeAccount: "acct_merchant",
    }),
    /only payment method/,
  );
});

test("buildOwnerPaymentMethodList falls back to the Konnect default", async () => {
  await withStripeKey(async () => {
    const stripe = fakeStripe({
      "/payment_methods?limit=100": { data: [LINK, CARD] },
      "/v1/customers/cus_1": { invoice_settings: {} },
    });
    const { items } = await buildOwnerPaymentMethodList({
      stripeCustomerId: "cus_1",
      konnectDefaultPaymentMethodId: "pm_link",
      deps: { fetchImpl: stripe.fetchImpl, signal: AbortSignal.timeout(5_000) },
    });
    assert.deepEqual(
      items.filter((item) => item.isDefault).map((item) => item.id),
      ["pm_link"],
    );
  });
});

test("buildOwnerPaymentMethodList returns [] when nothing is attached", async () => {
  await withStripeKey(async () => {
    const stripe = fakeStripe({
      "/payment_methods?limit=100": { data: [] },
      "/v1/customers/cus_1": { invoice_settings: {} },
    });
    const { items, orphanLinkIds } = await buildOwnerPaymentMethodList({
      stripeCustomerId: "cus_1",
      konnectDefaultPaymentMethodId: null,
      deps: { fetchImpl: stripe.fetchImpl, signal: AbortSignal.timeout(5_000) },
    });
    assert.deepEqual(items, []);
    assert.deepEqual(orphanLinkIds, []);
  });
});

test("buildOwnerPaymentMethodList hydrates Konnect default via retrieve when list empty", async () => {
  await withStripeKey(async () => {
    const stripe = fakeStripe({
      "/payment_methods?limit=100": { data: [] },
      "/v1/customers/cus_1": { invoice_settings: {} },
      "/v1/payment_methods/pm_card": { ...CARD, customer: "cus_1" },
    });
    const { items } = await buildOwnerPaymentMethodList({
      stripeCustomerId: "cus_1",
      konnectDefaultPaymentMethodId: "pm_card",
      deps: { fetchImpl: stripe.fetchImpl, signal: AbortSignal.timeout(5_000) },
    });
    assert.equal(items.length, 1);
    assert.equal(items[0]?.id, "pm_card");
    assert.equal(items[0]?.isDefault, true);
    assert.equal(items[0]?.last4, "4242");
    assert.ok(
      stripe.calls.some((path) => path.includes("/v1/payment_methods/pm_card")),
    );
  });
});

test("buildOwnerPaymentMethodList ignores retrieved default for another customer", async () => {
  await withStripeKey(async () => {
    const stripe = fakeStripe({
      "/payment_methods?limit=100": { data: [] },
      "/v1/customers/cus_1": { invoice_settings: {} },
      "/v1/payment_methods/pm_card": { ...CARD, customer: "cus_other" },
    });
    const { items } = await buildOwnerPaymentMethodList({
      stripeCustomerId: "cus_1",
      konnectDefaultPaymentMethodId: "pm_card",
      deps: { fetchImpl: stripe.fetchImpl, signal: AbortSignal.timeout(5_000) },
    });
    assert.deepEqual(items, []);
  });
});

test("listOwnerPaymentMethods returns [] without Stripe key", async () => {
  const previousSecret = process.env.STRIPE_SECRET_KEY;
  const previousApi = process.env.STRIPE_API_KEY;
  delete process.env.STRIPE_SECRET_KEY;
  delete process.env.STRIPE_API_KEY;
  try {
    assert.deepEqual(await listOwnerPaymentMethods("user_1"), []);
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

test("resolveOwnerBillingCheckoutReturnUrl allows /billing/upgrade callbacks", () => {
  const previous = process.env.NEXTAUTH_URL;
  process.env.NEXTAUTH_URL = "https://app.example";
  try {
    const fallback = "https://app.example/billing";
    assert.equal(
      resolveOwnerBillingCheckoutReturnUrl(
        "https://app.example/billing/upgrade?plan=owner_paid_50&pm=attached",
        fallback,
      ),
      "https://app.example/billing/upgrade?plan=owner_paid_50&pm=attached",
    );
    assert.equal(
      resolveOwnerBillingCheckoutReturnUrl(
        "https://evil.example/billing",
        fallback,
      ),
      fallback,
    );
    assert.equal(
      resolveOwnerBillingCheckoutReturnUrl(
        "https://app.example/apps",
        fallback,
      ),
      fallback,
    );
    assert.equal(
      resolveOwnerBillingCheckoutReturnUrl(
        "https://app.example/billing-evil",
        fallback,
      ),
      fallback,
    );
  } finally {
    if (previous === undefined) {
      delete process.env.NEXTAUTH_URL;
    } else {
      process.env.NEXTAUTH_URL = previous;
    }
  }
});
