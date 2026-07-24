import assert from "node:assert/strict";
import test from "node:test";
import type { OpenMeter } from "@openmeter/sdk";
import { ensureStripeCustomerAppData } from "./stripe-customer-data";
import { resetHostedOpenMeterClientForTests } from "./client";

test("ensureStripeCustomerAppData returns existing self-hosted stripeCustomerId", async (t) => {
  const previousUrl = process.env.OPENMETER_URL;
  const previousKey = process.env.OPENMETER_API_KEY;
  const previousStripe = process.env.STRIPE_SECRET_KEY;
  process.env.OPENMETER_URL = "http://127.0.0.1:48888";
  delete process.env.OPENMETER_API_KEY;
  delete process.env.STRIPE_SECRET_KEY;

  t.after(() => {
    process.env.OPENMETER_URL = previousUrl;
    if (previousKey === undefined) delete process.env.OPENMETER_API_KEY;
    else process.env.OPENMETER_API_KEY = previousKey;
    if (previousStripe === undefined) delete process.env.STRIPE_SECRET_KEY;
    else process.env.STRIPE_SECRET_KEY = previousStripe;
    resetHostedOpenMeterClientForTests();
  });

  let created = false;
  const client = {
    customers: {
      stripe: {
        get: async () => ({
          type: "stripe" as const,
          stripeCustomerId: "cus_existing",
        }),
        upsert: async () => {
          created = true;
          return { type: "stripe" as const, stripeCustomerId: "cus_new" };
        },
      },
    },
  } as unknown as OpenMeter;

  const id = await ensureStripeCustomerAppData({
    client,
    customerId: "cust_1",
    customerKey: "app_x:user",
  });
  assert.equal(id, "cus_existing");
  assert.equal(created, false);
});

test("ensureStripeCustomerAppData creates Stripe customer and upserts when missing", async (t) => {
  const previousUrl = process.env.OPENMETER_URL;
  const previousKey = process.env.OPENMETER_API_KEY;
  const previousStripe = process.env.STRIPE_SECRET_KEY;
  process.env.OPENMETER_URL = "http://127.0.0.1:48888";
  delete process.env.OPENMETER_API_KEY;
  process.env.STRIPE_SECRET_KEY = "sk_test_unit";

  const originalFetch = globalThis.fetch;
  let upserted: string | null = null;

  t.after(() => {
    globalThis.fetch = originalFetch;
    process.env.OPENMETER_URL = previousUrl;
    if (previousKey === undefined) delete process.env.OPENMETER_API_KEY;
    else process.env.OPENMETER_API_KEY = previousKey;
    if (previousStripe === undefined) delete process.env.STRIPE_SECRET_KEY;
    else process.env.STRIPE_SECRET_KEY = previousStripe;
    resetHostedOpenMeterClientForTests();
  });

  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.includes("api.stripe.com/v1/customers")) {
      assert.equal(init?.method, "POST");
      return new Response(JSON.stringify({ id: "cus_created_123" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    throw new Error(`Unexpected fetch: ${url}`);
  }) as typeof fetch;

  const client = {
    customers: {
      stripe: {
        get: async () => {
          throw new Error("not found");
        },
        upsert: async (_id: string, body: { stripeCustomerId: string }) => {
          upserted = body.stripeCustomerId;
          return { type: "stripe" as const, stripeCustomerId: body.stripeCustomerId };
        },
      },
    },
  } as unknown as OpenMeter;

  const id = await ensureStripeCustomerAppData({
    client,
    customerId: "cust_2",
    customerKey: "app_x:user2",
  });
  assert.equal(id, "cus_created_123");
  assert.equal(upserted, "cus_created_123");
});

test("ensureStripeCustomerAppData fails loud without STRIPE_SECRET_KEY", async (t) => {
  const previousUrl = process.env.OPENMETER_URL;
  const previousKey = process.env.OPENMETER_API_KEY;
  const previousStripe = process.env.STRIPE_SECRET_KEY;
  const previousApi = process.env.STRIPE_API_KEY;
  process.env.OPENMETER_URL = "http://127.0.0.1:48888";
  delete process.env.OPENMETER_API_KEY;
  delete process.env.STRIPE_SECRET_KEY;
  delete process.env.STRIPE_API_KEY;

  t.after(() => {
    process.env.OPENMETER_URL = previousUrl;
    if (previousKey === undefined) delete process.env.OPENMETER_API_KEY;
    else process.env.OPENMETER_API_KEY = previousKey;
    if (previousStripe === undefined) delete process.env.STRIPE_SECRET_KEY;
    else process.env.STRIPE_SECRET_KEY = previousStripe;
    if (previousApi === undefined) delete process.env.STRIPE_API_KEY;
    else process.env.STRIPE_API_KEY = previousApi;
  });

  const client = {
    customers: {
      stripe: {
        get: async () => {
          throw new Error("missing");
        },
        upsert: async () => undefined,
      },
    },
  } as unknown as OpenMeter;

  await assert.rejects(
    () =>
      ensureStripeCustomerAppData({
        client,
        customerId: "cust_3",
      }),
    /STRIPE_SECRET_KEY is required/,
  );
});
