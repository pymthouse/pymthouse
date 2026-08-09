import assert from "node:assert/strict";
import test from "node:test";

import {
  AUTO_TOP_UP_METADATA_FLAG,
  autoTopUpGrantIdempotencyKey,
  createOffSessionAutoTopUpPaymentIntent,
  isAutoTopUpPaymentIntentMetadata,
  usdMicrosToStripeCents,
} from "@/lib/stripe/auto-topup-charge";

test("autoTopUpGrantIdempotencyKey prefixes trimmed payment intent id", () => {
  assert.equal(
    autoTopUpGrantIdempotencyKey("  pi_abc  "),
    "autotopup:pi_abc",
  );
});

test("isAutoTopUpPaymentIntentMetadata requires flag=1", () => {
  assert.equal(isAutoTopUpPaymentIntentMetadata(null), false);
  assert.equal(isAutoTopUpPaymentIntentMetadata(undefined), false);
  assert.equal(isAutoTopUpPaymentIntentMetadata({}), false);
  assert.equal(
    isAutoTopUpPaymentIntentMetadata({ [AUTO_TOP_UP_METADATA_FLAG]: "0" }),
    false,
  );
  assert.equal(
    isAutoTopUpPaymentIntentMetadata({ [AUTO_TOP_UP_METADATA_FLAG]: "1" }),
    true,
  );
});

test("usdMicrosToStripeCents converts and validates bounds", () => {
  assert.equal(usdMicrosToStripeCents(5_000_000n), 500);
  assert.equal(usdMicrosToStripeCents(5_009_999n), 500);
  assert.throws(() => usdMicrosToStripeCents(0n), /positive/);
  assert.throws(() => usdMicrosToStripeCents(-1n), /positive/);
  assert.throws(() => usdMicrosToStripeCents(49_999n), /at least \$0\.50/);
});

test("createOffSessionAutoTopUpPaymentIntent fails when Stripe is unconfigured", async (t) => {
  const prevSecret = process.env.STRIPE_SECRET_KEY;
  const prevApi = process.env.STRIPE_API_KEY;
  t.after(() => {
    if (prevSecret === undefined) delete process.env.STRIPE_SECRET_KEY;
    else process.env.STRIPE_SECRET_KEY = prevSecret;
    if (prevApi === undefined) delete process.env.STRIPE_API_KEY;
    else process.env.STRIPE_API_KEY = prevApi;
  });
  delete process.env.STRIPE_SECRET_KEY;
  delete process.env.STRIPE_API_KEY;

  const result = await createOffSessionAutoTopUpPaymentIntent({
    stripeCustomerId: "cus_1",
    paymentMethodId: "pm_1",
    amountUsdMicros: 5_000_000n,
    clientId: "app_1",
    externalUserId: "eu_1",
    fetchImpl: async () => {
      throw new Error("fetch should not run");
    },
  });
  assert.deepEqual(result, { ok: false, error: "stripe_unconfigured" });
});

test("createOffSessionAutoTopUpPaymentIntent rejects invalid amounts before fetch", async (t) => {
  const prevSecret = process.env.STRIPE_SECRET_KEY;
  t.after(() => {
    if (prevSecret === undefined) delete process.env.STRIPE_SECRET_KEY;
    else process.env.STRIPE_SECRET_KEY = prevSecret;
  });
  process.env.STRIPE_SECRET_KEY = "sk_test_auto_topup";

  const result = await createOffSessionAutoTopUpPaymentIntent({
    stripeCustomerId: "cus_1",
    paymentMethodId: "pm_1",
    amountUsdMicros: 100n,
    clientId: "app_1",
    externalUserId: "eu_1",
    fetchImpl: async () => {
      throw new Error("fetch should not run");
    },
  });
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.match(result.error, /at least \$0\.50/);
  }
});

test("createOffSessionAutoTopUpPaymentIntent posts USD intent and succeeds", async (t) => {
  const prevSecret = process.env.STRIPE_SECRET_KEY;
  t.after(() => {
    if (prevSecret === undefined) delete process.env.STRIPE_SECRET_KEY;
    else process.env.STRIPE_SECRET_KEY = prevSecret;
  });
  process.env.STRIPE_SECRET_KEY = "sk_test_auto_topup";

  let seenBody = "";
  let seenAccount: string | null = null;
  const result = await createOffSessionAutoTopUpPaymentIntent({
    stripeCustomerId: "cus_1",
    paymentMethodId: "pm_1",
    amountUsdMicros: 5_000_000n,
    clientId: "app_1",
    externalUserId: "eu_1",
    currency: "USD",
    stripeAccount: "acct_merchant",
    fetchImpl: async (_url, init) => {
      seenBody = String(init?.body ?? "");
      const headers = init?.headers as Record<string, string>;
      seenAccount = headers["Stripe-Account"] ?? null;
      return new Response(
        JSON.stringify({ id: "pi_ok", status: "succeeded" }),
        { status: 200 },
      );
    },
  });

  assert.deepEqual(result, {
    ok: true,
    paymentIntentId: "pi_ok",
    status: "succeeded",
  });
  assert.equal(seenAccount, "acct_merchant");
  assert.match(seenBody, /currency=usd/);
  assert.match(seenBody, /amount=500/);
  assert.match(seenBody, /metadata%5Bpymthouse_auto_topup%5D=1/);
  assert.match(seenBody, /metadata%5Bclient_id%5D=app_1/);
});

test("createOffSessionAutoTopUpPaymentIntent maps Stripe HTTP errors", async (t) => {
  const prevSecret = process.env.STRIPE_SECRET_KEY;
  t.after(() => {
    if (prevSecret === undefined) delete process.env.STRIPE_SECRET_KEY;
    else process.env.STRIPE_SECRET_KEY = prevSecret;
  });
  process.env.STRIPE_SECRET_KEY = "sk_test_auto_topup";

  const result = await createOffSessionAutoTopUpPaymentIntent({
    stripeCustomerId: "cus_1",
    paymentMethodId: "pm_1",
    amountUsdMicros: 5_000_000n,
    clientId: "app_1",
    externalUserId: "eu_1",
    fetchImpl: async () =>
      new Response(JSON.stringify({ error: { message: "card_declined" } }), {
        status: 402,
      }),
  });
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.error, "card_declined");
  }
});

test("createOffSessionAutoTopUpPaymentIntent handles network failures", async (t) => {
  const prevSecret = process.env.STRIPE_SECRET_KEY;
  t.after(() => {
    if (prevSecret === undefined) delete process.env.STRIPE_SECRET_KEY;
    else process.env.STRIPE_SECRET_KEY = prevSecret;
  });
  process.env.STRIPE_SECRET_KEY = "sk_test_auto_topup";

  const result = await createOffSessionAutoTopUpPaymentIntent({
    stripeCustomerId: "cus_1",
    paymentMethodId: "pm_1",
    amountUsdMicros: 5_000_000n,
    clientId: "app_1",
    externalUserId: "eu_1",
    fetchImpl: async () => {
      throw new Error("network down");
    },
  });
  assert.deepEqual(result, { ok: false, error: "stripe_request_failed" });
});

test("createOffSessionAutoTopUpPaymentIntent rejects non-succeeded status", async (t) => {
  const prevSecret = process.env.STRIPE_SECRET_KEY;
  t.after(() => {
    if (prevSecret === undefined) delete process.env.STRIPE_SECRET_KEY;
    else process.env.STRIPE_SECRET_KEY = prevSecret;
  });
  process.env.STRIPE_SECRET_KEY = "sk_test_auto_topup";

  const result = await createOffSessionAutoTopUpPaymentIntent({
    stripeCustomerId: "cus_1",
    paymentMethodId: "pm_1",
    amountUsdMicros: 5_000_000n,
    clientId: "app_1",
    externalUserId: "eu_1",
    fetchImpl: async () =>
      new Response(
        JSON.stringify({ id: "pi_pending", status: "requires_action" }),
        { status: 200 },
      ),
  });
  assert.deepEqual(result, {
    ok: false,
    error: "payment_intent_requires_action",
    status: "requires_action",
  });
});

test("createOffSessionAutoTopUpPaymentIntent rejects missing payment intent id", async (t) => {
  const prevSecret = process.env.STRIPE_SECRET_KEY;
  t.after(() => {
    if (prevSecret === undefined) delete process.env.STRIPE_SECRET_KEY;
    else process.env.STRIPE_SECRET_KEY = prevSecret;
  });
  process.env.STRIPE_SECRET_KEY = "sk_test_auto_topup";

  const result = await createOffSessionAutoTopUpPaymentIntent({
    stripeCustomerId: "cus_1",
    paymentMethodId: "pm_1",
    amountUsdMicros: 5_000_000n,
    clientId: "app_1",
    externalUserId: "eu_1",
    fetchImpl: async () =>
      new Response(JSON.stringify({ status: "succeeded" }), { status: 200 }),
  });
  assert.deepEqual(result, {
    ok: false,
    error: "missing_payment_intent_id",
    status: "succeeded",
  });
});
