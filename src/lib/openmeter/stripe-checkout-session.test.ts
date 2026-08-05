import assert from "node:assert/strict";
import test from "node:test";
import type { OpenMeter } from "@openmeter/sdk";
import { resetHostedOpenMeterClientForTests } from "./client";
import {
  createOpenMeterStripeCheckoutSession,
  isStripeCheckoutUrl,
  stripeCheckoutRedirectUrl,
} from "./stripe-checkout-session";

test("isStripeCheckoutUrl allows only https checkout.stripe.com hosts", () => {
  assert.equal(isStripeCheckoutUrl("https://checkout.stripe.com/c/pay/cs_test"), true);
  assert.equal(
    isStripeCheckoutUrl("https://pay.checkout.stripe.com/c/pay/cs_test"),
    true,
  );
  assert.equal(isStripeCheckoutUrl("http://checkout.stripe.com/c/pay/cs_test"), false);
  assert.equal(isStripeCheckoutUrl("https://evil.example/checkout.stripe.com"), false);
  assert.equal(isStripeCheckoutUrl("https://checkout.stripe.com.evil.example/"), false);
  assert.equal(isStripeCheckoutUrl("not-a-url"), false);
  assert.equal(
    stripeCheckoutRedirectUrl("https://checkout.stripe.com/c/pay/cs_test"),
    "https://checkout.stripe.com/c/pay/cs_test",
  );
  assert.equal(
    stripeCheckoutRedirectUrl(
      "https://checkout.stripe.com/c/pay/cs_live_abc#fidkdWxOYHwnPyd1blpx",
    ),
    "https://checkout.stripe.com/c/pay/cs_live_abc#fidkdWxOYHwnPyd1blpx",
  );
  assert.equal(stripeCheckoutRedirectUrl("https://evil.example/"), null);
});

function withKonnectEnv(t: test.TestContext): void {
  const savedUrl = process.env.OPENMETER_URL;
  const savedKey = process.env.OPENMETER_API_KEY;
  const savedMode = process.env.OPENMETER_ROUTE_MODE;
  process.env.OPENMETER_URL = "https://us.api.konghq.com/v3/openmeter";
  process.env.OPENMETER_API_KEY = "km_test_key";
  process.env.OPENMETER_ROUTE_MODE = "hosted";
  t.after(() => {
    if (savedUrl === undefined) delete process.env.OPENMETER_URL;
    else process.env.OPENMETER_URL = savedUrl;
    if (savedKey === undefined) delete process.env.OPENMETER_API_KEY;
    else process.env.OPENMETER_API_KEY = savedKey;
    if (savedMode === undefined) delete process.env.OPENMETER_ROUTE_MODE;
    else process.env.OPENMETER_ROUTE_MODE = savedMode;
    resetHostedOpenMeterClientForTests();
  });
}

test("createOpenMeterStripeCheckoutSession uses Konnect customer billing path", async (t) => {
  withKonnectEnv(t);

  const calls: Array<{ url: string; method: string; body: unknown }> = [];
  t.mock.method(globalThis, "fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    calls.push({ url, method: init?.method ?? "GET", body });
    assert.equal(
      new URL(url).pathname,
      "/v3/openmeter/customers/01CUSTOMERULID000000000001/billing/stripe/checkout-sessions",
    );
    return new Response(
      JSON.stringify({
        url: "https://checkout.stripe.com/c/pay/cs_test_konnect",
        session_id: "cs_test_konnect",
        customer_id: "01CUSTOMERULID000000000001",
        stripe_customer_id: "cus_x",
        setup_intent_id: "seti_x",
        created_at: "2026-01-01T00:00:00.000Z",
        mode: "setup",
      }),
      { status: 201, headers: { "Content-Type": "application/json" } },
    );
  });

  const result = await createOpenMeterStripeCheckoutSession({
    client: {} as OpenMeter,
    customerId: "01CUSTOMERULID000000000001",
    successUrl: "https://app.example/billing?pm=attached",
    cancelUrl: "https://app.example/billing",
    currency: "usd",
  });

  assert.equal(result.checkoutUrl, "https://checkout.stripe.com/c/pay/cs_test_konnect");
  assert.equal(result.sessionId, "cs_test_konnect");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, "POST");
  assert.deepEqual(calls[0].body, {
    stripe_options: {
      success_url: "https://app.example/billing?pm=attached",
      cancel_url: "https://app.example/billing",
      currency: "USD",
    },
  });
});

test("createOpenMeterStripeCheckoutSession uses SDK on self-hosted", async (t) => {
  const previousUrl = process.env.OPENMETER_URL;
  const previousKey = process.env.OPENMETER_API_KEY;
  const previousMode = process.env.OPENMETER_ROUTE_MODE;
  process.env.OPENMETER_URL = "http://127.0.0.1:48888";
  delete process.env.OPENMETER_API_KEY;
  process.env.OPENMETER_ROUTE_MODE = "self_hosted";
  t.after(() => {
    if (previousUrl === undefined) delete process.env.OPENMETER_URL;
    else process.env.OPENMETER_URL = previousUrl;
    if (previousKey === undefined) delete process.env.OPENMETER_API_KEY;
    else process.env.OPENMETER_API_KEY = previousKey;
    if (previousMode === undefined) delete process.env.OPENMETER_ROUTE_MODE;
    else process.env.OPENMETER_ROUTE_MODE = previousMode;
    resetHostedOpenMeterClientForTests();
  });

  let sdkCalled = false;
  const client = {
    apps: {
      stripe: {
        createCheckoutSession: async (body: {
          customer: { id: string };
          options: { successURL: string; cancelURL: string; currency?: string };
        }) => {
          sdkCalled = true;
          assert.equal(body.customer.id, "cust_self");
          assert.equal(body.options.currency, "USD");
          return {
            url: "https://checkout.stripe.com/c/pay/cs_test_self",
            sessionId: "cs_test_self",
          };
        },
      },
    },
  } as unknown as OpenMeter;

  const result = await createOpenMeterStripeCheckoutSession({
    client,
    customerId: "cust_self",
    successUrl: "https://app.example/ok",
    cancelUrl: "https://app.example/cancel",
    currency: "USD",
  });

  assert.equal(sdkCalled, true);
  assert.equal(result.checkoutUrl, "https://checkout.stripe.com/c/pay/cs_test_self");
  assert.equal(result.sessionId, "cs_test_self");
});

test("createOpenMeterStripeCheckoutSession rejects missing Konnect url", async (t) => {
  withKonnectEnv(t);

  t.mock.method(globalThis, "fetch", async () => {
    return new Response(
      JSON.stringify({
        session_id: "cs_no_url",
        customer_id: "01CUSTOMERULID000000000001",
        stripe_customer_id: "cus_x",
        setup_intent_id: "seti_x",
        created_at: "2026-01-01T00:00:00.000Z",
        mode: "setup",
      }),
      { status: 201, headers: { "Content-Type": "application/json" } },
    );
  });

  await assert.rejects(
    () =>
      createOpenMeterStripeCheckoutSession({
        client: {} as OpenMeter,
        customerId: "01CUSTOMERULID000000000001",
        successUrl: "https://app.example/ok",
        cancelUrl: "https://app.example/cancel",
      }),
    /Stripe checkout session URL unavailable/,
  );
});
