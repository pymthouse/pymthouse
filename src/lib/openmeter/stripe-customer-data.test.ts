import assert from "node:assert/strict";
import test from "node:test";
import type { OpenMeter } from "@openmeter/sdk";
import {
  clearKonnectStripeDefaultPaymentMethod,
  ensureKonnectCustomerStripeBilling,
  ensureStripeCustomerAppData,
  getKonnectCustomerBillingProfileId,
  getKonnectDefaultPaymentMethodId,
  getStripeCustomerAppDataId,
} from "./stripe-customer-data";
import { resetHostedOpenMeterClientForTests } from "./client";

/** Hostname check — avoids CodeQL js/incomplete-url-substring-sanitization. */
function isStripeApiHost(url: string): boolean {
  try {
    return new URL(url).hostname === "api.stripe.com";
  } catch {
    return false;
  }
}

function withKonnectEnv(t: test.TestContext): void {
  const savedUrl = process.env.OPENMETER_URL;
  const savedKey = process.env.OPENMETER_API_KEY;
  const savedMode = process.env.OPENMETER_ROUTE_MODE;
  const savedStripe = process.env.STRIPE_SECRET_KEY;
  process.env.OPENMETER_URL = "https://us.api.konghq.com/v3/openmeter";
  process.env.OPENMETER_API_KEY = "km_test_key";
  process.env.OPENMETER_ROUTE_MODE = "hosted";
  process.env.STRIPE_SECRET_KEY = "sk_test_unit";
  t.after(() => {
    if (savedUrl === undefined) delete process.env.OPENMETER_URL;
    else process.env.OPENMETER_URL = savedUrl;
    if (savedKey === undefined) delete process.env.OPENMETER_API_KEY;
    else process.env.OPENMETER_API_KEY = savedKey;
    if (savedMode === undefined) delete process.env.OPENMETER_ROUTE_MODE;
    else process.env.OPENMETER_ROUTE_MODE = savedMode;
    if (savedStripe === undefined) delete process.env.STRIPE_SECRET_KEY;
    else process.env.STRIPE_SECRET_KEY = savedStripe;
    resetHostedOpenMeterClientForTests();
  });
}

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
    if (isStripeApiHost(url) && new URL(url).pathname.startsWith("/v1/customers")) {
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

test("ensureStripeCustomerAppData on Konnect returns existing cus without profile", async (t) => {
  withKonnectEnv(t);
  t.mock.method(globalThis, "fetch", async (input: RequestInfo | URL) => {
    const url = String(input);
    assert.match(url, /\/customers\/cust_k1\/billing$/);
    return new Response(
      JSON.stringify({
        app_data: { stripe: { customer_id: "cus_konnect_existing" } },
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  });

  const id = await ensureStripeCustomerAppData({
    client: {} as OpenMeter,
    customerId: "cust_k1",
  });
  assert.equal(id, "cus_konnect_existing");
});

test("ensureStripeCustomerAppData on Konnect requires billingProfileId when creating", async (t) => {
  withKonnectEnv(t);
  t.mock.method(globalThis, "fetch", async () =>
    new Response("{}", {
      status: 404,
      headers: { "Content-Type": "application/json" },
    }),
  );

  await assert.rejects(
    () =>
      ensureStripeCustomerAppData({
        client: {} as OpenMeter,
        customerId: "cust_k2",
      }),
    /Konnect requires a Stripe billing profile id/,
  );
});

test("ensureKonnectCustomerStripeBilling creates Stripe customer and persists billing", async (t) => {
  withKonnectEnv(t);
  const calls: Array<{ url: string; method: string; body: string }> = [];
  t.mock.method(globalThis, "fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    const body = String(init?.body ?? "");
    calls.push({ url, method, body });

    if (isStripeApiHost(url) && new URL(url).pathname.startsWith("/v1/customers")) {
      return new Response(JSON.stringify({ id: "cus_created_k" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    if (url.includes("/customers/cust_k3/billing") && method === "GET") {
      return new Response("{}", {
        status: 404,
        headers: { "Content-Type": "application/json" },
      });
    }
    if (url.includes("/customers/cust_k3/billing") && method === "PUT") {
      assert.match(body, /cus_created_k/);
      assert.match(body, /prof_1/);
      return new Response(
        JSON.stringify({
          billing_profile: { id: "prof_1" },
          app_data: { stripe: { customer_id: "cus_created_k" } },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }
    throw new Error(`Unexpected fetch: ${method} ${url}`);
  });

  const id = await ensureKonnectCustomerStripeBilling({
    customerId: "cust_k3",
    customerKey: "app_x:user",
    name: "Acme",
    billingProfileId: "prof_1",
  });
  assert.equal(id, "cus_created_k");
  assert.ok(calls.some((c) => isStripeApiHost(c.url)));
});

test("ensureKonnectCustomerStripeBilling reuses existing Stripe customer", async (t) => {
  withKonnectEnv(t);
  let stripeCreates = 0;
  t.mock.method(globalThis, "fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    if (isStripeApiHost(url)) {
      stripeCreates += 1;
      throw new Error("should not create stripe customer");
    }
    if (url.includes("/customers/cust_k4/billing") && method === "GET") {
      return new Response(
        JSON.stringify({
          app_data: { stripe: { customer_id: "cus_reuse" } },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }
    if (url.includes("/customers/cust_k4/billing") && method === "PUT") {
      return new Response(
        JSON.stringify({
          billing_profile: { id: "prof_2" },
          app_data: { stripe: { customer_id: "cus_reuse" } },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }
    throw new Error(`Unexpected fetch: ${method} ${url}`);
  });

  const id = await ensureKonnectCustomerStripeBilling({
    customerId: "cust_k4",
    billingProfileId: "prof_2",
  });
  assert.equal(id, "cus_reuse");
  assert.equal(stripeCreates, 0);
});

test("ensureKonnectCustomerStripeBilling recovers Stripe customer from label mirror", async (t) => {
  withKonnectEnv(t);
  let stripeCreates = 0;
  t.mock.method(globalThis, "fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    if (isStripeApiHost(url)) {
      stripeCreates += 1;
      throw new Error("should not create stripe customer");
    }
    // Moving to the free profile wiped app_data, so only the mirror remains.
    if (url.includes("/customers/cust_k6/billing") && method === "GET") {
      return new Response(JSON.stringify({ app_data: {} }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    if (url.includes("/customers/cust_k6/billing") && method === "PUT") {
      return new Response(
        JSON.stringify({
          billing_profile: { id: "prof_6" },
          app_data: { stripe: { customer_id: "cus_mirrored" } },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }
    if (url.includes("/customers/cust_k6") && method === "PUT") {
      return new Response(JSON.stringify({ id: "cust_k6" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    if (url.includes("/customers/cust_k6") && method === "GET") {
      return new Response(
        JSON.stringify({
          id: "cust_k6",
          key: "app_x:user",
          name: "Acme",
          labels: { pymthouse_stripe_customer_id: "cus_mirrored" },
          usage_attribution: { subject_keys: ["app_x:user"] },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }
    throw new Error(`Unexpected fetch: ${method} ${url}`);
  });

  const id = await ensureKonnectCustomerStripeBilling({
    customerId: "cust_k6",
    billingProfileId: "prof_6",
  });
  assert.equal(id, "cus_mirrored");
  assert.equal(stripeCreates, 0);
});

test("ensureKonnectCustomerStripeBilling recovers Stripe customer from settlement label", async (t) => {
  withKonnectEnv(t);
  let stripeCreates = 0;
  t.mock.method(globalThis, "fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    if (isStripeApiHost(url)) {
      stripeCreates += 1;
      throw new Error("should not create stripe customer");
    }
    if (url.includes("/customers/cust_k8/billing") && method === "GET") {
      return new Response(JSON.stringify({ app_data: {} }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    if (url.includes("/customers/cust_k8/billing") && method === "PUT") {
      return new Response(
        JSON.stringify({
          billing_profile: { id: "prof_8" },
          app_data: { stripe: { customer_id: "cus_settlement" } },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }
    if (url.includes("/customers/cust_k8") && method === "PUT") {
      return new Response(JSON.stringify({ id: "cust_k8" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    if (url.includes("/customers/cust_k8") && method === "GET") {
      return new Response(
        JSON.stringify({
          id: "cust_k8",
          key: "eu_user",
          name: "eu_user",
          labels: { stripe_customer_id: "cus_settlement" },
          usage_attribution: { subject_keys: ["eu_user"] },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }
    throw new Error(`Unexpected fetch: ${method} ${url}`);
  });

  const id = await ensureKonnectCustomerStripeBilling({
    customerId: "cust_k8",
    billingProfileId: "prof_8",
  });
  assert.equal(id, "cus_settlement");
  assert.equal(stripeCreates, 0);
});

test("ensureKonnectCustomerStripeBilling mirrors with snake_case subject keys intact", async (t) => {
  withKonnectEnv(t);
  let customerPut: Record<string, unknown> | null = null;
  t.mock.method(globalThis, "fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    if (isStripeApiHost(url)) {
      return new Response(JSON.stringify({ id: "cus_fresh" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    if (url.includes("/customers/cust_k7/billing")) {
      return new Response(
        JSON.stringify({
          billing_profile: { id: "prof_7" },
          app_data: method === "PUT" ? { stripe: { customer_id: "cus_fresh" } } : {},
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }
    if (url.includes("/customers/cust_k7") && method === "PUT") {
      customerPut = JSON.parse(String(init?.body ?? "{}"));
      return new Response(JSON.stringify({ id: "cust_k7" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    if (url.includes("/customers/cust_k7") && method === "GET") {
      return new Response(
        JSON.stringify({
          id: "cust_k7",
          name: "Acme",
          labels: {},
          usage_attribution: { subject_keys: ["app_x:user"] },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }
    throw new Error(`Unexpected fetch: ${method} ${url}`);
  });

  await ensureKonnectCustomerStripeBilling({
    customerId: "cust_k7",
    billingProfileId: "prof_7",
  });

  assert.ok(customerPut, "expected a customer PUT mirroring the Stripe id");
  const body = customerPut as {
    labels?: Record<string, string>;
    usage_attribution?: { subject_keys?: string[] };
    usageAttribution?: unknown;
  };
  assert.equal(body.labels?.pymthouse_stripe_customer_id, "cus_fresh");
  assert.equal(body.labels?.stripe_customer_id, "cus_fresh");
  // camelCase would be ignored by Konnect and silently wipe the subject keys.
  assert.equal(body.usageAttribution, undefined);
  assert.deepEqual(body.usage_attribution?.subject_keys, ["app_x:user"]);
});

test("ensureKonnectCustomerStripeBilling fails when app data not persisted", async (t) => {
  withKonnectEnv(t);
  t.mock.method(globalThis, "fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    if (isStripeApiHost(url)) {
      return new Response(JSON.stringify({ id: "cus_x" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    if (method === "GET") {
      return new Response("{}", { status: 404 });
    }
    return new Response(
      JSON.stringify({ billing_profile: { id: "prof_3" }, app_data: {} }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  });

  await assert.rejects(
    () =>
      ensureKonnectCustomerStripeBilling({
        customerId: "cust_k5",
        billingProfileId: "prof_3",
      }),
    /did not persist Stripe customer app data/,
  );
});

test("getStripeCustomerAppDataId and Konnect billing helpers", async (t) => {
  withKonnectEnv(t);
  t.mock.method(globalThis, "fetch", async (input: RequestInfo | URL) => {
    assert.match(String(input), /\/customers\/cust_helpers\/billing$/);
    return new Response(
      JSON.stringify({
        billing_profile: { id: "prof_h" },
        app_data: {
          stripe: {
            customer_id: "cus_h",
            default_payment_method_id: "pm_h",
          },
        },
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  });

  assert.equal(
    await getStripeCustomerAppDataId({
      client: {} as OpenMeter,
      customerId: "cust_helpers",
    }),
    "cus_h",
  );
  assert.equal(await getKonnectCustomerBillingProfileId("cust_helpers"), "prof_h");
  assert.equal(await getKonnectDefaultPaymentMethodId("cust_helpers"), "pm_h");
});

test("clearKonnectStripeDefaultPaymentMethod drops the stored pointer", async (t) => {
  withKonnectEnv(t);
  let putBody = "";
  t.mock.method(globalThis, "fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    assert.match(url, /\/customers\/cust_clear\/billing$/);
    if (method === "GET") {
      return new Response(
        JSON.stringify({
          billing_profile: { id: "prof_c" },
          app_data: {
            stripe: {
              customer_id: "cus_c",
              default_payment_method_id: "pm_detached",
            },
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }
    putBody = String(init?.body ?? "");
    return new Response(
      JSON.stringify({
        billing_profile: { id: "prof_c" },
        app_data: { stripe: { customer_id: "cus_c" } },
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  });

  await clearKonnectStripeDefaultPaymentMethod({
    customerId: "cust_clear",
    stripeCustomerId: "cus_c",
  });

  assert.match(putBody, /cus_c/);
  assert.doesNotMatch(putBody, /default_payment_method_id/);
});

test("Konnect billing helpers return null outside Konnect mode", async (t) => {
  const previousUrl = process.env.OPENMETER_URL;
  const previousKey = process.env.OPENMETER_API_KEY;
  process.env.OPENMETER_URL = "http://127.0.0.1:48888";
  delete process.env.OPENMETER_API_KEY;
  t.after(() => {
    process.env.OPENMETER_URL = previousUrl;
    if (previousKey === undefined) delete process.env.OPENMETER_API_KEY;
    else process.env.OPENMETER_API_KEY = previousKey;
  });

  assert.equal(await getKonnectCustomerBillingProfileId("cust_x"), null);
  assert.equal(await getKonnectDefaultPaymentMethodId("cust_x"), null);
});
