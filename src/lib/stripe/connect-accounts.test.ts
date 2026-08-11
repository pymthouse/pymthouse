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
import {
  __testMapMerchantInvoice,
  __testMerchantConnectInvoices,
} from "./merchant-connect";

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

test("merchant invoice mapper preserves Stripe invoice fields for app-user billing", () => {
  assert.deepEqual(
    __testMapMerchantInvoice({
      id: "in_connected",
      number: "M-42",
      status: "paid",
      currency: "usd",
      total: 1234,
      customer: "cus_connected",
      created: 1_735_689_600,
      period_start: 1_735_603_200,
      period_end: 1_735_862_400,
    }),
    {
      id: "in_connected",
      number: "M-42",
      status: "paid",
      currency: "USD",
      totalAmount: "12.34",
      customerId: "cus_connected",
      issuedAt: "2025-01-01T00:00:00.000Z",
      periodStart: "2024-12-31T00:00:00.000Z",
      periodEnd: "2025-01-03T00:00:00.000Z",
      externalInvoicingId: "in_connected",
      invoiceType: "stripe_connect",
    },
  );
});

test("merchant invoice helpers omit invalid data and normalize timestamps", () => {
  assert.equal(__testMerchantConnectInvoices.mapMerchantInvoice({}), null);
  assert.equal(__testMerchantConnectInvoices.invoiceDate(null), undefined);
  assert.equal(
    __testMerchantConnectInvoices.invoiceDate(1_735_689_600),
    "2025-01-01T00:00:00.000Z",
  );
});

test("mapLegacyAutoTopUpPaymentIntent maps succeeded auto top-ups only", () => {
  assert.deepEqual(
    __testMerchantConnectInvoices.mapLegacyAutoTopUpPaymentIntent({
      id: "pi_topup_1",
      amount: 500,
      currency: "usd",
      status: "succeeded",
      customer: "cus_connected",
      created: 1_735_689_600,
      metadata: { pymthouse_auto_topup: "1" },
    }),
    {
      id: "pi_topup_1",
      number: "Auto top-up",
      status: "succeeded",
      currency: "USD",
      totalAmount: "5.00",
      customerId: "cus_connected",
      issuedAt: "2025-01-01T00:00:00.000Z",
      externalInvoicingId: "pi_topup_1",
      invoiceType: "auto_topup",
    },
  );
  assert.equal(
    __testMerchantConnectInvoices.mapLegacyAutoTopUpPaymentIntent({
      id: "pi_other",
      amount: 500,
      status: "succeeded",
      metadata: {},
    }),
    null,
  );
  assert.equal(
    __testMerchantConnectInvoices.mapLegacyAutoTopUpPaymentIntent({
      id: "pi_pending",
      amount: 500,
      status: "requires_action",
      metadata: { pymthouse_auto_topup: "1" },
    }),
    null,
  );
});

test("mapMerchantPaymentIntent includes ad-hoc succeeded Connect charges", () => {
  assert.deepEqual(
    __testMerchantConnectInvoices.mapMerchantPaymentIntent({
      id: "pi_charge_1",
      amount: 200,
      currency: "usd",
      status: "succeeded",
      customer: "cus_connected",
      created: 1_735_689_600,
      metadata: {},
    }),
    {
      id: "pi_charge_1",
      number: "Payment",
      status: "succeeded",
      currency: "USD",
      totalAmount: "2.00",
      customerId: "cus_connected",
      issuedAt: "2025-01-01T00:00:00.000Z",
      externalInvoicingId: "pi_charge_1",
      invoiceType: "payment",
    },
  );
  assert.deepEqual(
    __testMerchantConnectInvoices.mapMerchantPaymentIntent({
      id: "pi_topup_2",
      amount: 500,
      currency: "usd",
      status: "succeeded",
      customer: "cus_connected",
      created: 1_735_689_600,
      metadata: { pymthouse_auto_topup: "1" },
    })?.number,
    "Auto top-up",
  );
  assert.equal(
    __testMerchantConnectInvoices.mapMerchantPaymentIntent({
      id: "pi_zero",
      amount: 0,
      status: "succeeded",
      metadata: {},
    }),
    null,
  );
});

test("mapMerchantPaymentIntent skips invoice-backed PaymentIntents", () => {
  assert.equal(
    __testMerchantConnectInvoices.mapMerchantPaymentIntent({
      id: "pi_invoice_paid",
      amount: 250,
      currency: "usd",
      status: "succeeded",
      customer: "cus_connected",
      created: 1_735_689_600,
      invoice: "in_1ABC",
      metadata: {},
    }),
    null,
  );
  assert.equal(
    __testMerchantConnectInvoices.mapMerchantPaymentIntent({
      id: "pi_invoice_expanded",
      amount: 250,
      status: "succeeded",
      invoice: { id: "in_1DEF" },
      metadata: { pymthouse_auto_topup: "1" },
    }),
    null,
  );
  assert.equal(
    __testMerchantConnectInvoices.paymentIntentInvoiceId({
      invoice: "in_1ABC",
    }),
    "in_1ABC",
  );
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

test("merchant invoice request sends Connected Account credentials", async (t) => {
  withEnv(t, { STRIPE_SECRET_KEY: "sk_test_unit" });
  t.mock.method(globalThis, "fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    assert.equal(String(input), "https://api.stripe.com/v1/invoices?customer=cus_1");
    const headers = new Headers(init?.headers);
    assert.equal(headers.get("Authorization"), "Bearer sk_test_unit");
    assert.equal(headers.get("Stripe-Account"), "acct_merchant");
    return jsonResponse({ data: [] });
  });

  assert.deepEqual(
    await __testMerchantConnectInvoices.stripeConnectInvoiceRequest<{
      data: unknown[];
    }>("acct_merchant", "/v1/invoices?customer=cus_1"),
    { data: [] },
  );
});

test("merchant invoice request reports Stripe failures", async (t) => {
  withEnv(t, { STRIPE_SECRET_KEY: "sk_test_unit" });
  t.mock.method(globalThis, "fetch", async () =>
    jsonResponse({ error: { message: "invoice denied" } }, 403),
  );

  await assert.rejects(
    () =>
      __testMerchantConnectInvoices.stripeConnectInvoiceRequest(
        "acct_merchant",
        "/v1/invoices",
      ),
    /Stripe Connect invoice request failed \(403\): invoice denied/,
  );
});

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
      "https://builder.example/apps/app_1/payments?connect=refresh",
    returnUrl:
      "https://builder.example/apps/app_1/payments?connected=1",
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
  t.mock.method(globalThis, "fetch", async (_input: RequestInfo | URL, init?: RequestInit) => {
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
  t.mock.method(globalThis, "fetch", async (_input: RequestInfo | URL, init?: RequestInit) => {
    bodies.push(String(init?.body ?? ""));
    return jsonResponse({ id: "cs_test_1", url: "https://checkout.stripe.com/c/pay/cs_test_1" });
  });

  const setup = await createConnectedCheckoutSession({
    accountId: "acct_1",
    customerId: "cus_1",
    successUrl: "https://ok",
    cancelUrl: "https://cancel",
    mode: "setup",
    metadata: {
      pymthouse_client_id: "app_merchant",
      external_user_id: "user_1",
    },
  });
  assert.equal(setup.sessionId, "cs_test_1");
  assert.match(bodies[0]!, /mode=setup/);
  assert.match(
    bodies[0]!,
    /setup_intent_data%5Bmetadata%5D%5Bpymthouse_client_id%5D=app_merchant/,
  );

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
  assert.match(
    bodies[1]!,
    /payment_intent_data%5Bsetup_future_usage%5D=off_session/,
  );
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

test("createConnectedCheckoutSession rejects payment mode without a valid amount", async (t) => {
  withEnv(t, { STRIPE_SECRET_KEY: "sk_test_unit" });
  await assert.rejects(
    () =>
      createConnectedCheckoutSession({
        accountId: "acct_1",
        customerId: "cus_1",
        successUrl: "https://ok",
        cancelUrl: "https://cancel",
        mode: "payment",
        amountCents: 0,
      }),
    /amountCents must be a positive integer/,
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
