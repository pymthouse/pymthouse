import test from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";

import {
  __setRestoreAppUserBillingProfileAfterPaymentMethodAttachedForTests,
  __setRestoreAppUserBillingProfileForCheckoutSessionForTests,
} from "@/lib/openmeter/app-user-payment-method";
import { __setGrantAllowanceUsdMicrosForTests } from "@/lib/openmeter/grant-allowance";
import { legacyAutoTopUpGrantIdempotencyKey } from "@/lib/stripe/legacy-auto-topup";
import {
  __setResolveAppLivemodeForWebhookForTests,
} from "@/lib/stripe/merchant-connect";
import { topUpGrantIdempotencyKey } from "@/lib/stripe/topup-checkout";
import {
  __setMerchantTopUpAccountMatchesForTests,
  __setResolveAppBillingCurrencyForTests,
  __setTopUpClientOwnedByOwnerForTests,
} from "@/lib/stripe/topup-ownership";

const CONNECT_SECRET = "whsec_connect_test_secret";
const PLATFORM_SECRET = "whsec_platform_test_secret";

function signBody(secret: string, timestamp: number, rawBody: string): string {
  const payload = `${timestamp}.${rawBody}`;
  const v1 = createHmac("sha256", secret).update(payload, "utf8").digest("hex");
  return `t=${timestamp},v1=${v1}`;
}

function topUpEventBody(
  type: string,
  extras?: { account?: string },
): string {
  return JSON.stringify({
    type,
    ...(extras?.account ? { account: extras.account } : {}),
    data: {
      object: {
        id: "cs_test_route_1",
        mode: "payment",
        payment_status: "paid",
        amount_total: 2500,
        currency: "usd",
        metadata: {
          pymthouse_topup: "1",
          owner_user_id: "user_route_1",
          client_id: "app_pub_route_1",
          amount_usd_micros: "25000000",
        },
      },
    },
  });
}

function merchantTopUpEventBody(
  type: string,
  extras?: { account?: string },
): string {
  return JSON.stringify({
    type,
    ...(extras?.account ? { account: extras.account } : {}),
    data: {
      object: {
        id: "cs_test_merchant_1",
        mode: "payment",
        payment_status: "paid",
        amount_total: 2500,
        currency: "usd",
        metadata: {
          pymthouse_topup: "1",
          external_user_id: "eu_route_1",
          client_id: "app_pub_route_1",
          amount_usd_micros: "25000000",
        },
      },
    },
  });
}

function autoTopUpPaymentIntentBody(extras?: {
  account?: string;
  clientId?: string;
  externalUserId?: string;
  currency?: string | null;
}): string {
  const currency =
    extras && "currency" in extras ? extras.currency : "usd";
  return JSON.stringify({
    type: "payment_intent.succeeded",
    ...(extras?.account ? { account: extras.account } : {}),
    data: {
      object: {
        id: "pi_auto_topup_1",
        amount: 1000,
        ...(currency != null ? { currency } : {}),
        status: "succeeded",
        metadata: {
          pymthouse_auto_topup: "1",
          client_id: extras?.clientId ?? "app_pub_route_1",
          external_user_id: extras?.externalUserId ?? "eu_route_1",
        },
      },
    },
  });
}

function setupIntentRestoreBody(extras?: { account?: string }): string {
  return JSON.stringify({
    type: "setup_intent.succeeded",
    ...(extras?.account ? { account: extras.account } : {}),
    data: {
      object: {
        id: "seti_restore_1",
        payment_method: "pm_restore_1",
        metadata: {
          pymthouse_client_id: "app_pub_route_1",
          external_user_id: "eu_route_1",
        },
      },
    },
  });
}

function checkoutPmRestoreBody(extras?: { account?: string }): string {
  return JSON.stringify({
    type: "checkout.session.completed",
    ...(extras?.account ? { account: extras.account } : {}),
    data: {
      object: {
        id: "cs_pm_restore_1",
        mode: "setup",
        payment_status: "paid",
        setup_intent: "seti_restore_1",
        metadata: {
          pymthouse_client_id: "app_spoofed",
          external_user_id: "eu_spoofed",
        },
      },
    },
  });
}

function withWebhookEnv(
  t: { after: (fn: () => void) => void },
  env: {
    connect?: string;
    platform?: string;
  },
): void {
  const prevConnect = process.env.STRIPE_CONNECT_WEBHOOK_SECRET;
  const prevPlatform = process.env.STRIPE_WEBHOOK_SECRET;
  t.after(() => {
    if (prevConnect === undefined) delete process.env.STRIPE_CONNECT_WEBHOOK_SECRET;
    else process.env.STRIPE_CONNECT_WEBHOOK_SECRET = prevConnect;
    if (prevPlatform === undefined) delete process.env.STRIPE_WEBHOOK_SECRET;
    else process.env.STRIPE_WEBHOOK_SECRET = prevPlatform;
    __setGrantAllowanceUsdMicrosForTests(null);
    __setTopUpClientOwnedByOwnerForTests(null);
    __setMerchantTopUpAccountMatchesForTests(null);
    __setResolveAppBillingCurrencyForTests(null);
    __setResolveAppLivemodeForWebhookForTests(null);
    __setRestoreAppUserBillingProfileAfterPaymentMethodAttachedForTests(null);
    __setRestoreAppUserBillingProfileForCheckoutSessionForTests(null);
  });
  if (env.connect === undefined) delete process.env.STRIPE_CONNECT_WEBHOOK_SECRET;
  else process.env.STRIPE_CONNECT_WEBHOOK_SECRET = env.connect;
  if (env.platform === undefined) delete process.env.STRIPE_WEBHOOK_SECRET;
  else process.env.STRIPE_WEBHOOK_SECRET = env.platform;
  // Auto-topup settlement matches app defaultCurrency (USD unless overridden).
  __setResolveAppBillingCurrencyForTests(async () => "usd");
  // Live webhook plane: apps default to live so restore unit tests skip Neon.
  __setResolveAppLivemodeForWebhookForTests(async () => true);
}

async function postSigned(
  rawBody: string,
  secret: string,
): Promise<Response> {
  const { POST } = await import("./route");
  const now = Math.floor(Date.now() / 1000);
  return POST(
    new Request("http://localhost/webhooks/stripe", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "stripe-signature": signBody(secret, now, rawBody),
      },
      body: rawBody,
    }),
  );
}

test("POST checkout.session.completed credits via grantAllowanceUsdMicros", async (t) => {
  withWebhookEnv(t, { platform: PLATFORM_SECRET });
  __setTopUpClientOwnedByOwnerForTests(async () => true);
  const calls: Array<Record<string, unknown>> = [];
  __setGrantAllowanceUsdMicrosForTests(async (input) => {
    calls.push({ ...input, amountUsdMicros: input.amountUsdMicros.toString() });
    return {
      externalUserId: input.externalUserId,
      source: input.source,
      grantedUsdMicros: input.amountUsdMicros.toString(),
      featureKey: "usd_credits",
      balance: null,
    };
  });

  const rawBody = topUpEventBody("checkout.session.completed");
  const res = await postSigned(rawBody, PLATFORM_SECRET);
  assert.equal(res.status, 200);
  const json = (await res.json()) as {
    received?: boolean;
    credited?: boolean;
    sessionId?: string;
  };
  assert.equal(json.received, true);
  assert.equal(json.credited, true);
  assert.equal(json.sessionId, "cs_test_route_1");
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], {
    clientId: "app_pub_route_1",
    externalUserId: "owner:user_route_1",
    amountUsdMicros: "25000000",
    source: "topup",
    idempotencyKey: topUpGrantIdempotencyKey("cs_test_route_1"),
  });
});

test("POST checkout.session.async_payment_succeeded credits via grantAllowanceUsdMicros", async (t) => {
  withWebhookEnv(t, { platform: PLATFORM_SECRET });
  __setTopUpClientOwnedByOwnerForTests(async () => true);
  let granted = false;
  __setGrantAllowanceUsdMicrosForTests(async () => {
    granted = true;
    return {
      externalUserId: "owner:user_route_1",
      source: "topup",
      grantedUsdMicros: "25000000",
      featureKey: "usd_credits",
      balance: null,
    };
  });

  const rawBody = topUpEventBody("checkout.session.async_payment_succeeded");
  const res = await postSigned(rawBody, PLATFORM_SECRET);
  assert.equal(res.status, 200);
  const json = (await res.json()) as { credited?: boolean };
  assert.equal(json.credited, true);
  assert.equal(granted, true);
});

test("POST ignores owner top-up when only Connect secret verifies", async (t) => {
  withWebhookEnv(t, {
    connect: CONNECT_SECRET,
    platform: "not-a-whsec",
  });
  let granted = false;
  __setTopUpClientOwnedByOwnerForTests(async () => true);
  __setGrantAllowanceUsdMicrosForTests(async () => {
    granted = true;
    return {
      externalUserId: "owner:user_route_1",
      source: "topup",
      grantedUsdMicros: "25000000",
      featureKey: "usd_credits",
      balance: null,
    };
  });

  const rawBody = topUpEventBody("checkout.session.completed");
  const res = await postSigned(rawBody, CONNECT_SECRET);
  assert.equal(res.status, 200);
  const json = (await res.json()) as { credited?: boolean; ignored?: string };
  assert.equal(json.credited, undefined);
  assert.equal(json.ignored, "topup_requires_platform_secret");
  assert.equal(granted, false);
});

test("POST ignores owner top-up with Connect account field even when platform-signed", async (t) => {
  withWebhookEnv(t, { platform: PLATFORM_SECRET });
  let granted = false;
  __setTopUpClientOwnedByOwnerForTests(async () => true);
  __setGrantAllowanceUsdMicrosForTests(async () => {
    granted = true;
    return {
      externalUserId: "owner:user_route_1",
      source: "topup",
      grantedUsdMicros: "25000000",
      featureKey: "usd_credits",
      balance: null,
    };
  });

  const rawBody = topUpEventBody("checkout.session.completed", {
    account: "acct_connected",
  });
  const res = await postSigned(rawBody, PLATFORM_SECRET);
  assert.equal(res.status, 200);
  const json = (await res.json()) as { ignored?: string };
  assert.equal(json.ignored, "connect_account_event");
  assert.equal(granted, false);
});

test("POST ignores top-up when clientId is not owned by ownerUserId", async (t) => {
  withWebhookEnv(t, { platform: PLATFORM_SECRET });
  let granted = false;
  __setTopUpClientOwnedByOwnerForTests(async () => false);
  __setGrantAllowanceUsdMicrosForTests(async () => {
    granted = true;
    return {
      externalUserId: "owner:user_route_1",
      source: "topup",
      grantedUsdMicros: "25000000",
      featureKey: "usd_credits",
      balance: null,
    };
  });

  const rawBody = topUpEventBody("checkout.session.completed");
  const res = await postSigned(rawBody, PLATFORM_SECRET);
  assert.equal(res.status, 200);
  const json = (await res.json()) as { ignored?: string };
  assert.equal(json.ignored, "client_not_owned_by_owner");
  assert.equal(granted, false);
});

test("POST merchant Connect top-up credits bare externalUserId", async (t) => {
  withWebhookEnv(t, {
    connect: CONNECT_SECRET,
    platform: PLATFORM_SECRET,
  });
  __setMerchantTopUpAccountMatchesForTests(async () => true);
  const calls: Array<Record<string, unknown>> = [];
  __setGrantAllowanceUsdMicrosForTests(async (input) => {
    calls.push({ ...input, amountUsdMicros: input.amountUsdMicros.toString() });
    return {
      externalUserId: input.externalUserId,
      source: input.source,
      grantedUsdMicros: input.amountUsdMicros.toString(),
      featureKey: "usd_credits",
      balance: null,
    };
  });

  const rawBody = merchantTopUpEventBody("checkout.session.completed", {
    account: "acct_merchant_1",
  });
  const res = await postSigned(rawBody, CONNECT_SECRET);
  assert.equal(res.status, 200);
  const json = (await res.json()) as {
    credited?: boolean;
    sessionId?: string;
  };
  assert.equal(json.credited, true);
  assert.equal(json.sessionId, "cs_test_merchant_1");
  assert.deepEqual(calls[0], {
    clientId: "app_pub_route_1",
    externalUserId: "eu_route_1",
    amountUsdMicros: "25000000",
    source: "topup",
    idempotencyKey: topUpGrantIdempotencyKey("cs_test_merchant_1"),
  });
});

test("POST merchant top-up accepts platform-signed event with account", async (t) => {
  withWebhookEnv(t, { platform: PLATFORM_SECRET });
  __setMerchantTopUpAccountMatchesForTests(async () => true);
  let granted = false;
  __setGrantAllowanceUsdMicrosForTests(async () => {
    granted = true;
    return {
      externalUserId: "eu_route_1",
      source: "topup",
      grantedUsdMicros: "25000000",
      featureKey: "usd_credits",
      balance: null,
    };
  });

  const rawBody = merchantTopUpEventBody("checkout.session.completed", {
    account: "acct_merchant_1",
  });
  const res = await postSigned(rawBody, PLATFORM_SECRET);
  assert.equal(res.status, 200);
  const json = (await res.json()) as { credited?: boolean };
  assert.equal(json.credited, true);
  assert.equal(granted, true);
});

test("POST merchant top-up ignores missing account field", async (t) => {
  withWebhookEnv(t, {
    connect: CONNECT_SECRET,
    platform: PLATFORM_SECRET,
  });
  let granted = false;
  __setMerchantTopUpAccountMatchesForTests(async () => true);
  __setGrantAllowanceUsdMicrosForTests(async () => {
    granted = true;
    return {
      externalUserId: "eu_route_1",
      source: "topup",
      grantedUsdMicros: "25000000",
      featureKey: "usd_credits",
      balance: null,
    };
  });

  const rawBody = merchantTopUpEventBody("checkout.session.completed");
  const res = await postSigned(rawBody, CONNECT_SECRET);
  assert.equal(res.status, 200);
  const json = (await res.json()) as { ignored?: string };
  assert.equal(json.ignored, "merchant_topup_missing_account");
  assert.equal(granted, false);
});

test("POST merchant top-up ignores account mismatch", async (t) => {
  withWebhookEnv(t, {
    connect: CONNECT_SECRET,
    platform: PLATFORM_SECRET,
  });
  __setMerchantTopUpAccountMatchesForTests(async () => false);
  let granted = false;
  __setGrantAllowanceUsdMicrosForTests(async () => {
    granted = true;
    return {
      externalUserId: "eu_route_1",
      source: "topup",
      grantedUsdMicros: "25000000",
      featureKey: "usd_credits",
      balance: null,
    };
  });

  const rawBody = merchantTopUpEventBody("checkout.session.completed", {
    account: "acct_wrong",
  });
  const res = await postSigned(rawBody, CONNECT_SECRET);
  assert.equal(res.status, 200);
  const json = (await res.json()) as { ignored?: string };
  assert.equal(json.ignored, "connect_account_mismatch");
  assert.equal(granted, false);
});

test("POST rejects when signature matches neither configured secret", async (t) => {
  withWebhookEnv(t, {
    connect: CONNECT_SECRET,
    platform: PLATFORM_SECRET,
  });
  __setGrantAllowanceUsdMicrosForTests(async () => {
    throw new Error("grant should not run");
  });

  const rawBody = topUpEventBody("checkout.session.completed");
  const res = await postSigned(rawBody, "whsec_wrong_secret");
  assert.equal(res.status, 401);
  const json = (await res.json()) as { error?: string };
  assert.equal(json.error, "invalid_signature");
});

test("POST auto-topup credits when Connect account matches", async (t) => {
  withWebhookEnv(t, {
    connect: CONNECT_SECRET,
    platform: PLATFORM_SECRET,
  });
  __setMerchantTopUpAccountMatchesForTests(async () => true);
  const calls: Array<Record<string, unknown>> = [];
  __setGrantAllowanceUsdMicrosForTests(async (input) => {
    calls.push({ ...input, amountUsdMicros: input.amountUsdMicros.toString() });
    return {
      externalUserId: input.externalUserId,
      source: input.source,
      grantedUsdMicros: input.amountUsdMicros.toString(),
      featureKey: "usd_credits",
      balance: null,
    };
  });

  const rawBody = autoTopUpPaymentIntentBody({ account: "acct_merchant_1" });
  const res = await postSigned(rawBody, CONNECT_SECRET);
  assert.equal(res.status, 200);
  const json = (await res.json()) as {
    credited?: boolean;
    paymentIntentId?: string;
  };
  assert.equal(json.credited, true);
  assert.equal(json.paymentIntentId, "pi_auto_topup_1");
  assert.deepEqual(calls[0], {
    clientId: "app_pub_route_1",
    externalUserId: "eu_route_1",
    amountUsdMicros: "10000000",
    source: "topup",
    idempotencyKey: legacyAutoTopUpGrantIdempotencyKey("pi_auto_topup_1"),
  });
});

test("POST auto-topup ignores Connect account mismatch", async (t) => {
  withWebhookEnv(t, {
    connect: CONNECT_SECRET,
    platform: PLATFORM_SECRET,
  });
  __setMerchantTopUpAccountMatchesForTests(async () => false);
  let granted = false;
  __setGrantAllowanceUsdMicrosForTests(async () => {
    granted = true;
    return {
      externalUserId: "eu_route_1",
      source: "topup",
      grantedUsdMicros: "10000000",
      featureKey: "usd_credits",
      balance: null,
    };
  });

  const rawBody = autoTopUpPaymentIntentBody({ account: "acct_wrong" });
  const res = await postSigned(rawBody, CONNECT_SECRET);
  assert.equal(res.status, 200);
  const json = (await res.json()) as { ignored?: string };
  assert.equal(json.ignored, "connect_account_mismatch");
  assert.equal(granted, false);
});

test("POST auto-topup ignores currency mismatch vs app defaultCurrency", async (t) => {
  withWebhookEnv(t, {
    connect: CONNECT_SECRET,
    platform: PLATFORM_SECRET,
  });
  __setMerchantTopUpAccountMatchesForTests(async () => true);
  __setResolveAppBillingCurrencyForTests(async () => "usd");
  let granted = false;
  __setGrantAllowanceUsdMicrosForTests(async () => {
    granted = true;
    return {
      externalUserId: "eu_route_1",
      source: "topup",
      grantedUsdMicros: "10000000",
      featureKey: "usd_credits",
      balance: null,
    };
  });

  const rawBody = autoTopUpPaymentIntentBody({
    account: "acct_merchant_1",
    currency: "eur",
  });
  const res = await postSigned(rawBody, CONNECT_SECRET);
  assert.equal(res.status, 200);
  const json = (await res.json()) as { ignored?: string };
  assert.equal(json.ignored, "auto_topup_currency_mismatch");
  assert.equal(granted, false);
});

test("POST auto-topup ignores missing currency", async (t) => {
  withWebhookEnv(t, {
    connect: CONNECT_SECRET,
    platform: PLATFORM_SECRET,
  });
  __setMerchantTopUpAccountMatchesForTests(async () => true);
  let granted = false;
  __setGrantAllowanceUsdMicrosForTests(async () => {
    granted = true;
    return {
      externalUserId: "eu_route_1",
      source: "topup",
      grantedUsdMicros: "10000000",
      featureKey: "usd_credits",
      balance: null,
    };
  });

  const rawBody = autoTopUpPaymentIntentBody({
    account: "acct_merchant_1",
    currency: null,
  });
  const res = await postSigned(rawBody, CONNECT_SECRET);
  assert.equal(res.status, 200);
  const json = (await res.json()) as { ignored?: string };
  assert.equal(json.ignored, "auto_topup_currency_mismatch");
  assert.equal(granted, false);
});

test("POST auto-topup platform event requires platform secret", async (t) => {
  withWebhookEnv(t, {
    connect: CONNECT_SECRET,
    platform: "not-a-whsec",
  });
  let granted = false;
  __setGrantAllowanceUsdMicrosForTests(async () => {
    granted = true;
    return {
      externalUserId: "owner:user_route_1",
      source: "topup",
      grantedUsdMicros: "10000000",
      featureKey: "usd_credits",
      balance: null,
    };
  });

  const rawBody = autoTopUpPaymentIntentBody({
    externalUserId: "owner:user_route_1",
  });
  const res = await postSigned(rawBody, CONNECT_SECRET);
  assert.equal(res.status, 200);
  const json = (await res.json()) as { ignored?: string };
  assert.equal(json.ignored, "auto_topup_requires_platform_secret");
  assert.equal(granted, false);
});

test("POST auto-topup platform-signed owner event credits when client owned", async (t) => {
  withWebhookEnv(t, { platform: PLATFORM_SECRET });
  __setTopUpClientOwnedByOwnerForTests(async () => true);
  let granted = false;
  __setGrantAllowanceUsdMicrosForTests(async () => {
    granted = true;
    return {
      externalUserId: "owner:user_route_1",
      source: "topup",
      grantedUsdMicros: "10000000",
      featureKey: "usd_credits",
      balance: null,
    };
  });

  const rawBody = autoTopUpPaymentIntentBody({
    externalUserId: "owner:user_route_1",
  });
  const res = await postSigned(rawBody, PLATFORM_SECRET);
  assert.equal(res.status, 200);
  const json = (await res.json()) as { credited?: boolean };
  assert.equal(json.credited, true);
  assert.equal(granted, true);
});

test("POST auto-topup platform event ignores bare external_user_id", async (t) => {
  withWebhookEnv(t, { platform: PLATFORM_SECRET });
  let granted = false;
  __setGrantAllowanceUsdMicrosForTests(async () => {
    granted = true;
    return {
      externalUserId: "eu_route_1",
      source: "topup",
      grantedUsdMicros: "10000000",
      featureKey: "usd_credits",
      balance: null,
    };
  });

  const rawBody = autoTopUpPaymentIntentBody();
  const res = await postSigned(rawBody, PLATFORM_SECRET);
  assert.equal(res.status, 200);
  const json = (await res.json()) as { ignored?: string };
  assert.equal(json.ignored, "auto_topup_platform_requires_owner_subject");
  assert.equal(granted, false);
});

test("POST auto-topup platform event ignores client not owned by owner", async (t) => {
  withWebhookEnv(t, { platform: PLATFORM_SECRET });
  __setTopUpClientOwnedByOwnerForTests(async () => false);
  let granted = false;
  __setGrantAllowanceUsdMicrosForTests(async () => {
    granted = true;
    return {
      externalUserId: "owner:user_route_1",
      source: "topup",
      grantedUsdMicros: "10000000",
      featureKey: "usd_credits",
      balance: null,
    };
  });

  const rawBody = autoTopUpPaymentIntentBody({
    externalUserId: "owner:user_route_1",
  });
  const res = await postSigned(rawBody, PLATFORM_SECRET);
  assert.equal(res.status, 200);
  const json = (await res.json()) as { ignored?: string };
  assert.equal(json.ignored, "client_not_owned_by_owner");
  assert.equal(granted, false);
});

test("POST setup_intent restore requires matching Connect account", async (t) => {
  withWebhookEnv(t, {
    connect: CONNECT_SECRET,
    platform: PLATFORM_SECRET,
  });
  __setMerchantTopUpAccountMatchesForTests(async () => true);
  const restores: Array<Record<string, unknown>> = [];
  __setRestoreAppUserBillingProfileAfterPaymentMethodAttachedForTests(
    async (input) => {
      restores.push({ ...input });
    },
  );

  const rawBody = setupIntentRestoreBody({ account: "acct_merchant_1" });
  const res = await postSigned(rawBody, CONNECT_SECRET);
  assert.equal(res.status, 200);
  const json = (await res.json()) as { restored?: boolean; clientId?: string };
  assert.equal(json.restored, true);
  assert.equal(json.clientId, "app_pub_route_1");
  assert.deepEqual(restores[0], {
    clientId: "app_pub_route_1",
    externalUserId: "eu_route_1",
    paymentMethodId: "pm_restore_1",
  });
});

test("POST setup_intent restore ignores Connect account mismatch", async (t) => {
  withWebhookEnv(t, {
    connect: CONNECT_SECRET,
    platform: PLATFORM_SECRET,
  });
  __setMerchantTopUpAccountMatchesForTests(async () => false);
  let restored = false;
  __setRestoreAppUserBillingProfileAfterPaymentMethodAttachedForTests(
    async () => {
      restored = true;
    },
  );

  const rawBody = setupIntentRestoreBody({ account: "acct_wrong" });
  const res = await postSigned(rawBody, CONNECT_SECRET);
  assert.equal(res.status, 200);
  const json = (await res.json()) as { ignored?: string };
  assert.equal(json.ignored, "connect_account_mismatch");
  assert.equal(restored, false);
});

test("POST checkout PM restore prefers server-issued session mapping over metadata", async (t) => {
  withWebhookEnv(t, {
    connect: CONNECT_SECRET,
    platform: PLATFORM_SECRET,
  });
  let afterAttachCalled = false;
  __setRestoreAppUserBillingProfileAfterPaymentMethodAttachedForTests(
    async () => {
      afterAttachCalled = true;
    },
  );
  const sessions: string[] = [];
  __setRestoreAppUserBillingProfileForCheckoutSessionForTests(
    async (sessionId) => {
      sessions.push(sessionId);
      return { restored: true };
    },
  );

  const rawBody = checkoutPmRestoreBody({ account: "acct_merchant_1" });
  const res = await postSigned(rawBody, CONNECT_SECRET);
  assert.equal(res.status, 200);
  const json = (await res.json()) as { restored?: boolean };
  assert.equal(json.restored, true);
  assert.deepEqual(sessions, ["cs_pm_restore_1"]);
  assert.equal(afterAttachCalled, false);
});

const SANDBOX_PLATFORM_SECRET = "whsec_sandbox_platform_test";
const SANDBOX_CONNECT_SECRET = "whsec_sandbox_connect_test";

function withSandboxWebhookEnv(t: { after: (fn: () => void) => void }): void {
  const prevConnect = process.env.STRIPE_SANDBOX_CONNECT_WEBHOOK_SECRET;
  const prevPlatform = process.env.STRIPE_SANDBOX_WEBHOOK_SECRET;
  t.after(() => {
    if (prevConnect === undefined) {
      delete process.env.STRIPE_SANDBOX_CONNECT_WEBHOOK_SECRET;
    } else {
      process.env.STRIPE_SANDBOX_CONNECT_WEBHOOK_SECRET = prevConnect;
    }
    if (prevPlatform === undefined) {
      delete process.env.STRIPE_SANDBOX_WEBHOOK_SECRET;
    } else {
      process.env.STRIPE_SANDBOX_WEBHOOK_SECRET = prevPlatform;
    }
    __setGrantAllowanceUsdMicrosForTests(null);
    __setTopUpClientOwnedByOwnerForTests(null);
    __setMerchantTopUpAccountMatchesForTests(null);
    __setResolveAppBillingCurrencyForTests(null);
    __setResolveAppLivemodeForWebhookForTests(null);
    __setRestoreAppUserBillingProfileAfterPaymentMethodAttachedForTests(null);
    __setRestoreAppUserBillingProfileForCheckoutSessionForTests(null);
  });
  process.env.STRIPE_SANDBOX_WEBHOOK_SECRET = SANDBOX_PLATFORM_SECRET;
  process.env.STRIPE_SANDBOX_CONNECT_WEBHOOK_SECRET = SANDBOX_CONNECT_SECRET;
  __setResolveAppBillingCurrencyForTests(async () => "usd");
  __setResolveAppLivemodeForWebhookForTests(async () => false);
}

async function postSignedSandbox(
  rawBody: string,
  secret: string,
): Promise<Response> {
  const { POST } = await import("./sandbox/route");
  const now = Math.floor(Date.now() / 1000);
  return POST(
    new Request("http://localhost/webhooks/stripe/sandbox", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "stripe-signature": signBody(secret, now, rawBody),
      },
      body: rawBody,
    }),
  );
}

test("POST sandbox owner top-up does not grant production credits", async (t) => {
  withSandboxWebhookEnv(t);
  __setTopUpClientOwnedByOwnerForTests(async () => true);
  let granted = false;
  __setGrantAllowanceUsdMicrosForTests(async () => {
    granted = true;
    return {
      externalUserId: "owner:user_route_1",
      source: "topup",
      grantedUsdMicros: "25000000",
      featureKey: "usd_credits",
      balance: null,
    };
  });

  const rawBody = topUpEventBody("checkout.session.completed");
  const res = await postSignedSandbox(rawBody, SANDBOX_PLATFORM_SECRET);
  assert.equal(res.status, 200);
  const json = (await res.json()) as { credited?: boolean; ignored?: string };
  assert.equal(json.credited, undefined);
  assert.equal(json.ignored, "sandbox_owner_grant");
  assert.equal(granted, false);
});

test("POST sandbox merchant Connect top-up grants sandbox-plane credits", async (t) => {
  withSandboxWebhookEnv(t);
  __setMerchantTopUpAccountMatchesForTests(async () => true);
  const calls: Array<Record<string, unknown>> = [];
  __setGrantAllowanceUsdMicrosForTests(async (input) => {
    calls.push({ ...input, amountUsdMicros: input.amountUsdMicros.toString() });
    return {
      externalUserId: input.externalUserId,
      source: input.source,
      grantedUsdMicros: input.amountUsdMicros.toString(),
      featureKey: "usd_credits",
      balance: null,
    };
  });

  const rawBody = merchantTopUpEventBody("checkout.session.completed", {
    account: "acct_sandbox_1",
  });
  const res = await postSignedSandbox(rawBody, SANDBOX_CONNECT_SECRET);
  assert.equal(res.status, 200);
  const json = (await res.json()) as { credited?: boolean; ignored?: string };
  assert.equal(json.credited, true);
  assert.equal(json.ignored, undefined);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.externalUserId, "eu_route_1");
});

test("POST sandbox merchant Connect top-up ignores live app livemode mismatch", async (t) => {
  withSandboxWebhookEnv(t);
  __setMerchantTopUpAccountMatchesForTests(async () => true);
  __setResolveAppLivemodeForWebhookForTests(async () => true);
  let granted = false;
  __setGrantAllowanceUsdMicrosForTests(async () => {
    granted = true;
    return {
      externalUserId: "eu_route_1",
      source: "topup",
      grantedUsdMicros: "25000000",
      featureKey: "usd_credits",
      balance: null,
    };
  });

  const rawBody = merchantTopUpEventBody("checkout.session.completed", {
    account: "acct_sandbox_1",
  });
  const res = await postSignedSandbox(rawBody, SANDBOX_CONNECT_SECRET);
  assert.equal(res.status, 200);
  const json = (await res.json()) as { credited?: boolean; ignored?: string };
  assert.equal(json.credited, undefined);
  assert.equal(json.ignored, "livemode_mismatch");
  assert.equal(granted, false);
});

test("POST sandbox platform auto-topup does not grant owner credits", async (t) => {
  withSandboxWebhookEnv(t);
  __setTopUpClientOwnedByOwnerForTests(async () => true);
  let granted = false;
  __setGrantAllowanceUsdMicrosForTests(async () => {
    granted = true;
    return {
      externalUserId: "owner:user_route_1",
      source: "topup",
      grantedUsdMicros: "10000000",
      featureKey: "usd_credits",
      balance: null,
    };
  });

  const rawBody = autoTopUpPaymentIntentBody({
    externalUserId: "owner:user_route_1",
  });
  const res = await postSignedSandbox(rawBody, SANDBOX_PLATFORM_SECRET);
  assert.equal(res.status, 200);
  const json = (await res.json()) as { credited?: boolean; ignored?: string };
  assert.equal(json.credited, undefined);
  assert.equal(json.ignored, "sandbox_owner_grant");
  assert.equal(granted, false);
});

test("POST sandbox Connect auto-topup grants sandbox-plane credits", async (t) => {
  withSandboxWebhookEnv(t);
  __setMerchantTopUpAccountMatchesForTests(async () => true);
  let granted = false;
  __setGrantAllowanceUsdMicrosForTests(async () => {
    granted = true;
    return {
      externalUserId: "eu_route_1",
      source: "topup",
      grantedUsdMicros: "10000000",
      featureKey: "usd_credits",
      balance: null,
    };
  });

  const rawBody = autoTopUpPaymentIntentBody({ account: "acct_sandbox_1" });
  const res = await postSignedSandbox(rawBody, SANDBOX_CONNECT_SECRET);
  assert.equal(res.status, 200);
  const json = (await res.json()) as { credited?: boolean; ignored?: string };
  assert.equal(json.credited, true);
  assert.equal(json.ignored, undefined);
  assert.equal(granted, true);
});

test("POST sandbox setup_intent restore ignores live app livemode mismatch", async (t) => {
  withSandboxWebhookEnv(t);
  __setMerchantTopUpAccountMatchesForTests(async () => true);
  // Default / live app: stripeLivemode true must not restore from sandbox plane.
  __setResolveAppLivemodeForWebhookForTests(async () => true);
  let restored = false;
  __setRestoreAppUserBillingProfileAfterPaymentMethodAttachedForTests(
    async () => {
      restored = true;
    },
  );

  const rawBody = setupIntentRestoreBody({ account: "acct_live_1" });
  const res = await postSignedSandbox(rawBody, SANDBOX_CONNECT_SECRET);
  assert.equal(res.status, 200);
  const json = (await res.json()) as { ignored?: string; restored?: boolean };
  assert.equal(json.ignored, "livemode_mismatch");
  assert.equal(json.restored, undefined);
  assert.equal(restored, false);
});

test("POST sandbox setup_intent restore succeeds for sandbox app", async (t) => {
  withSandboxWebhookEnv(t);
  __setMerchantTopUpAccountMatchesForTests(async () => true);
  __setResolveAppLivemodeForWebhookForTests(async () => false);
  const restores: Array<Record<string, unknown>> = [];
  __setRestoreAppUserBillingProfileAfterPaymentMethodAttachedForTests(
    async (input) => {
      restores.push({ ...input });
    },
  );

  const rawBody = setupIntentRestoreBody({ account: "acct_sandbox_1" });
  const res = await postSignedSandbox(rawBody, SANDBOX_CONNECT_SECRET);
  assert.equal(res.status, 200);
  const json = (await res.json()) as { restored?: boolean; clientId?: string };
  assert.equal(json.restored, true);
  assert.equal(json.clientId, "app_pub_route_1");
  assert.deepEqual(restores[0], {
    clientId: "app_pub_route_1",
    externalUserId: "eu_route_1",
    paymentMethodId: "pm_restore_1",
  });
});
