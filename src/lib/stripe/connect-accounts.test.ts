import test from "node:test";
import assert from "node:assert/strict";
import {
  applicationFeeAmountCents,
  buildConnectOAuthAuthorizeUrl,
  connectAccountLinkUrls,
  connectOAuthCallbackUrl,
  createAccountOnboardingLink,
  createConnectedCheckoutSession,
  createConnectedCustomer,
  createConnectedInvoice,
  createMerchantConnectedAccount,
  exchangeConnectOAuthCode,
  refreshConnectedAccountStatus,
} from "./connect-accounts";

const ENV_KEYS = [
  "STRIPE_SECRET_KEY",
  "STRIPE_API_KEY",
  "STRIPE_CONNECT_CLIENT_ID",
  "NEXTAUTH_URL",
] as const;

function withEnv(
  t: test.TestContext,
  values: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>>,
): void {
  const saved: Record<string, string | undefined> = {};
  for (const key of ENV_KEYS) {
    saved[key] = process.env[key];
  }
  for (const key of ENV_KEYS) {
    const next = values[key];
    if (next === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = next;
    }
  }
  t.after(() => {
    for (const key of ENV_KEYS) {
      if (saved[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = saved[key];
      }
    }
  });
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

test("applicationFeeAmountCents computes bps fee", () => {
  assert.equal(
    applicationFeeAmountCents({ amountCents: 10_000, applicationFeeBps: 250 }),
    250,
  );
  assert.equal(
    applicationFeeAmountCents({ amountCents: 99, applicationFeeBps: 100 }),
    0,
  );
  assert.equal(
    applicationFeeAmountCents({ amountCents: 1000, applicationFeeBps: 0 }),
    0,
  );
});

test("connectAccountLinkUrls and connectOAuthCallbackUrl use public origin", (t) => {
  withEnv(t, { NEXTAUTH_URL: "https://builder.example" });
  assert.deepEqual(connectAccountLinkUrls("app_1"), {
    refreshUrl:
      "https://builder.example/apps/app_1/settings?tab=payments&connect=refresh",
    returnUrl:
      "https://builder.example/apps/app_1/settings?tab=payments&connected=1",
  });
  assert.equal(
    connectOAuthCallbackUrl("app_1"),
    "https://builder.example/api/v1/apps/app_1/billing/stripe/oauth/callback",
  );
});

test("buildConnectOAuthAuthorizeUrl encodes params", (t) => {
  withEnv(t, {
    STRIPE_SECRET_KEY: "sk_test_unit",
    STRIPE_CONNECT_CLIENT_ID: "ca_test_client",
  });
  const url = new URL(
    buildConnectOAuthAuthorizeUrl({
      state: "csrf",
      redirectUri: "https://builder.example/callback",
    }),
  );
  assert.equal(url.origin + url.pathname, "https://connect.stripe.com/oauth/authorize");
  assert.equal(url.searchParams.get("client_id"), "ca_test_client");
  assert.equal(url.searchParams.get("state"), "csrf");
  assert.equal(url.searchParams.get("redirect_uri"), "https://builder.example/callback");
});

test("buildConnectOAuthAuthorizeUrl requires client id", (t) => {
  withEnv(t, {
    STRIPE_SECRET_KEY: "sk_test_unit",
    STRIPE_CONNECT_CLIENT_ID: undefined,
  });
  assert.throws(
    () =>
      buildConnectOAuthAuthorizeUrl({
        state: "x",
        redirectUri: "https://example/cb",
      }),
    /STRIPE_CONNECT_CLIENT_ID/,
  );
});

test("createMerchantConnectedAccount falls back to Express v1 when v2 fails", async (t) => {
  withEnv(t, { STRIPE_SECRET_KEY: "sk_test_unit" });
  const calls: string[] = [];
  t.mock.method(globalThis, "fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push(`${init?.method ?? "GET"} ${url}`);
    if (url.includes("/v2/core/accounts")) {
      return jsonResponse({ error: { message: "v2 unavailable" } }, 400);
    }
    if (url.includes("/v1/accounts") && init?.method === "POST") {
      const body = String(init.body ?? "");
      assert.match(body, /type=express/);
      assert.match(body, /metadata%5Bpymthouse_client_id%5D=app_abc/);
      return jsonResponse({ id: "acct_express_1" });
    }
    throw new Error(`Unexpected fetch: ${url}`);
  });

  const id = await createMerchantConnectedAccount({
    clientId: "app_abc",
    email: "owner@example.com",
    displayName: "Acme",
  });
  assert.equal(id, "acct_express_1");
  assert.equal(calls.length, 2);
});

test("createMerchantConnectedAccount uses v2 id when available", async (t) => {
  withEnv(t, { STRIPE_SECRET_KEY: "sk_test_unit" });
  t.mock.method(globalThis, "fetch", async (input: RequestInfo | URL) => {
    if (String(input).includes("/v2/core/accounts")) {
      return jsonResponse({ id: "acct_v2_ready" });
    }
    throw new Error(`Unexpected fetch: ${String(input)}`);
  });
  assert.equal(
    await createMerchantConnectedAccount({ clientId: "app_1" }),
    "acct_v2_ready",
  );
});

test("createMerchantConnectedAccount rejects missing secret", async (t) => {
  withEnv(t, { STRIPE_SECRET_KEY: undefined, STRIPE_API_KEY: undefined });
  await assert.rejects(
    () => createMerchantConnectedAccount({ clientId: "app_1" }),
    /STRIPE_SECRET_KEY/,
  );
});

test("createMerchantConnectedAccount rejects invalid account id", async (t) => {
  withEnv(t, { STRIPE_SECRET_KEY: "sk_test_unit" });
  t.mock.method(globalThis, "fetch", async () => jsonResponse({ id: "not_an_acct" }));
  await assert.rejects(
    () => createMerchantConnectedAccount({ clientId: "app_1" }),
    /did not return a Connected Account id/,
  );
});

test("createAccountOnboardingLink and refreshConnectedAccountStatus", async (t) => {
  withEnv(t, { STRIPE_SECRET_KEY: "sk_test_unit" });
  t.mock.method(globalThis, "fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.includes("/v1/account_links")) {
      assert.equal(init?.method, "POST");
      return jsonResponse({ url: "https://connect.stripe.com/setup/e/xxx" });
    }
    if (url.includes("/v1/accounts/acct_1")) {
      return jsonResponse({
        id: "acct_1",
        charges_enabled: true,
        payouts_enabled: false,
        details_submitted: true,
      });
    }
    throw new Error(`Unexpected fetch: ${url}`);
  });

  assert.equal(
    await createAccountOnboardingLink({
      accountId: "acct_1",
      refreshUrl: "https://x/refresh",
      returnUrl: "https://x/return",
    }),
    "https://connect.stripe.com/setup/e/xxx",
  );
  assert.deepEqual(await refreshConnectedAccountStatus("acct_1"), {
    id: "acct_1",
    chargesEnabled: true,
    payoutsEnabled: false,
    detailsSubmitted: true,
  });
});

test("createAccountOnboardingLink fails when Stripe omits url", async (t) => {
  withEnv(t, { STRIPE_SECRET_KEY: "sk_test_unit" });
  t.mock.method(globalThis, "fetch", async () => jsonResponse({}));
  await assert.rejects(
    () =>
      createAccountOnboardingLink({
        accountId: "acct_1",
        refreshUrl: "https://x/r",
        returnUrl: "https://x/t",
      }),
    /Account Link URL unavailable/,
  );
});

test("exchangeConnectOAuthCode returns stripe_user_id", async (t) => {
  withEnv(t, { STRIPE_SECRET_KEY: "sk_test_unit" });
  t.mock.method(globalThis, "fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    assert.match(String(input), /\/v1\/oauth\/token$/);
    assert.equal(init?.method, "POST");
    return jsonResponse({ stripe_user_id: "acct_oauth_9" });
  });
  assert.equal(await exchangeConnectOAuthCode("auth_code"), "acct_oauth_9");
});

test("exchangeConnectOAuthCode rejects missing stripe_user_id", async (t) => {
  withEnv(t, { STRIPE_SECRET_KEY: "sk_test_unit" });
  t.mock.method(globalThis, "fetch", async () => jsonResponse({}));
  await assert.rejects(
    () => exchangeConnectOAuthCode("bad"),
    /did not return stripe_user_id/,
  );
});

test("createConnectedCustomer posts to Connected Account", async (t) => {
  withEnv(t, { STRIPE_SECRET_KEY: "sk_test_unit" });
  t.mock.method(globalThis, "fetch", async (_input, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    assert.equal(headers.get("Stripe-Account"), "acct_merchant");
    return jsonResponse({ id: "cus_connected_1" });
  });
  assert.equal(
    await createConnectedCustomer({
      accountId: "acct_merchant",
      name: "User",
      email: "u@example.com",
      metadata: { external_user_id: "u1" },
    }),
    "cus_connected_1",
  );
});

test("createConnectedCustomer rejects invalid customer id", async (t) => {
  withEnv(t, { STRIPE_SECRET_KEY: "sk_test_unit" });
  t.mock.method(globalThis, "fetch", async () => jsonResponse({ id: "bad" }));
  await assert.rejects(
    () => createConnectedCustomer({ accountId: "acct_1" }),
    /did not return a customer id/,
  );
});

test("createConnectedCheckoutSession setup and payment modes", async (t) => {
  withEnv(t, { STRIPE_SECRET_KEY: "sk_test_unit" });
  const bodies: string[] = [];
  t.mock.method(globalThis, "fetch", async (_input, init?: RequestInit) => {
    bodies.push(String(init?.body ?? ""));
    return jsonResponse({ id: "cs_test_1", url: "https://checkout.stripe.com/c/pay/cs_test_1" });
  });

  const setup = await createConnectedCheckoutSession({
    accountId: "acct_1",
    customerId: "cus_1",
    successUrl: "https://ok",
    cancelUrl: "https://cancel",
    mode: "setup",
  });
  assert.equal(setup.sessionId, "cs_test_1");
  assert.match(bodies[0]!, /mode=setup/);

  const payment = await createConnectedCheckoutSession({
    accountId: "acct_1",
    customerId: "cus_1",
    successUrl: "https://ok",
    cancelUrl: "https://cancel",
    mode: "payment",
    amountCents: 10_000,
    applicationFeeBps: 250,
  });
  assert.equal(payment.url, "https://checkout.stripe.com/c/pay/cs_test_1");
  assert.match(bodies[1]!, /mode=payment/);
  assert.match(bodies[1]!, /payment_intent_data.*application_fee_amount.*250/);
});

test("createConnectedCheckoutSession fails without session url", async (t) => {
  withEnv(t, { STRIPE_SECRET_KEY: "sk_test_unit" });
  t.mock.method(globalThis, "fetch", async () => jsonResponse({ id: "cs_x" }));
  await assert.rejects(
    () =>
      createConnectedCheckoutSession({
        accountId: "acct_1",
        customerId: "cus_1",
        successUrl: "https://ok",
        cancelUrl: "https://cancel",
      }),
    /Checkout session unavailable/,
  );
});

test("createConnectedInvoice creates item then invoice with fee", async (t) => {
  withEnv(t, { STRIPE_SECRET_KEY: "sk_test_unit" });
  const paths: string[] = [];
  t.mock.method(globalThis, "fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    paths.push(url);
    if (url.includes("/v1/invoiceitems")) {
      return jsonResponse({ id: "ii_1" });
    }
    if (url.includes("/v1/invoices")) {
      assert.match(String(init?.body ?? ""), /application_fee_amount=100/);
      return jsonResponse({
        id: "in_1",
        hosted_invoice_url: "https://invoice.stripe.com/i/in_1",
      });
    }
    throw new Error(`Unexpected fetch: ${url}`);
  });

  assert.deepEqual(
    await createConnectedInvoice({
      accountId: "acct_1",
      customerId: "cus_1",
      amountCents: 4000,
      applicationFeeBps: 250,
      description: "Usage",
    }),
    { invoiceId: "in_1", hostedInvoiceUrl: "https://invoice.stripe.com/i/in_1" },
  );
  assert.equal(paths.length, 2);
});

test("createConnectedInvoice fails without invoice id", async (t) => {
  withEnv(t, { STRIPE_SECRET_KEY: "sk_test_unit" });
  t.mock.method(globalThis, "fetch", async (input: RequestInfo | URL) => {
    if (String(input).includes("/v1/invoiceitems")) {
      return jsonResponse({ id: "ii_1" });
    }
    return jsonResponse({});
  });
  await assert.rejects(
    () =>
      createConnectedInvoice({
        accountId: "acct_1",
        customerId: "cus_1",
        amountCents: 100,
      }),
    /invoice create failed/,
  );
});

test("stripeFormRequest surfaces Stripe error messages", async (t) => {
  withEnv(t, { STRIPE_SECRET_KEY: "sk_test_unit" });
  t.mock.method(globalThis, "fetch", async () =>
    jsonResponse({ error: { message: "bad request" } }, 400),
  );
  await assert.rejects(
    () => refreshConnectedAccountStatus("acct_1"),
    /failed \(400\): bad request/,
  );
});
