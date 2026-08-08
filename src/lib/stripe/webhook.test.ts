import test from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { paymentsTabErrorMessage } from "./payments-tab-errors";
import {
  merchantConnectOAuthErrorCode,
  parseStripeAccountUpdated,
  parseStripeAttachedPaymentMethodId,
  parseStripeCompletedCheckoutSessionId,
  parseStripePaymentMethodAttached,
  resolveConnectWebhookSecret,
  resolveStripeWebhookSecrets,
  sanitizeStripeOAuthProviderError,
  verifyStripeWebhookSignature,
} from "./webhook";

function signBody(secret: string, timestamp: number, rawBody: string): string {
  const payload = `${timestamp}.${rawBody}`;
  const v1 = createHmac("sha256", secret).update(payload, "utf8").digest("hex");
  return `t=${timestamp},v1=${v1}`;
}

test("verifyStripeWebhookSignature accepts valid v1 signature", () => {
  const secret = "whsec_test_secret";
  const rawBody = '{"type":"account.updated"}';
  const now = 1_700_000_000;
  const header = signBody(secret, now, rawBody);
  assert.equal(
    verifyStripeWebhookSignature({
      rawBody,
      signatureHeader: header,
      secret,
      nowSec: now,
    }),
    true,
  );
});

test("verifyStripeWebhookSignature accepts any matching v1 when multiple are present", () => {
  const secret = "whsec_test_secret";
  const rawBody = '{"type":"account.updated"}';
  const now = 1_700_000_000;
  const good = signBody(secret, now, rawBody);
  const header = `${good},v1=${"00".repeat(32)}`;
  assert.equal(
    verifyStripeWebhookSignature({
      rawBody,
      signatureHeader: header,
      secret,
      nowSec: now,
    }),
    true,
  );
});

test("verifyStripeWebhookSignature rejects tampered body and skew", () => {
  const secret = "whsec_test_secret";
  const rawBody = '{"type":"account.updated"}';
  const now = 1_700_000_000;
  const header = signBody(secret, now, rawBody);
  assert.equal(
    verifyStripeWebhookSignature({
      rawBody: rawBody + "x",
      signatureHeader: header,
      secret,
      nowSec: now,
    }),
    false,
  );
  assert.equal(
    verifyStripeWebhookSignature({
      rawBody,
      signatureHeader: header,
      secret,
      nowSec: now + 301,
      toleranceSec: 300,
    }),
    false,
  );
});

test("parseStripeAccountUpdated extracts Connect flags", () => {
  const body = JSON.stringify({
    type: "account.updated",
    data: {
      object: {
        id: "acct_123",
        charges_enabled: true,
        payouts_enabled: false,
        details_submitted: true,
      },
    },
  });
  assert.deepEqual(parseStripeAccountUpdated(body), {
    accountId: "acct_123",
    chargesEnabled: true,
    payoutsEnabled: false,
    detailsSubmitted: true,
  });
  assert.equal(parseStripeAccountUpdated('{"type":"customer.created"}'), null);
});

test("payment-method restore parsing accepts Checkout and SetupIntent metadata", () => {
  const checkout = JSON.stringify({
    type: "checkout.session.completed",
    data: {
      object: {
        id: "cs_restore",
        metadata: {
          pymthouse_client_id: "app_merchant",
          external_user_id: "user_1",
        },
      },
    },
  });
  assert.deepEqual(parseStripePaymentMethodAttached(checkout), {
    clientId: "app_merchant",
    externalUserId: "user_1",
    checkoutSessionId: "cs_restore",
    paymentMethodId: null,
  });
  assert.equal(parseStripeCompletedCheckoutSessionId(checkout), "cs_restore");

  const setupIntent = JSON.stringify({
    type: "setup_intent.succeeded",
    data: {
      object: {
        id: "seti_restore",
        payment_method: "pm_attached_1",
        metadata: {
          pymthouse_client_id: "app_owner_rollup",
          external_user_id: "owner_1",
        },
      },
    },
  });
  assert.deepEqual(parseStripePaymentMethodAttached(setupIntent), {
    clientId: "app_owner_rollup",
    externalUserId: "owner_1",
    checkoutSessionId: null,
    paymentMethodId: "pm_attached_1",
  });
  assert.equal(parseStripeCompletedCheckoutSessionId(setupIntent), null);
  assert.equal(
    parseStripeAttachedPaymentMethodId(setupIntent),
    "pm_attached_1",
  );
});

test("payment-method restore parsing rejects incomplete metadata", () => {
  assert.equal(
    parseStripePaymentMethodAttached(
      JSON.stringify({
        type: "checkout.session.completed",
        data: { object: { id: "cs_missing", metadata: {} } },
      }),
    ),
    null,
  );
});

test("merchantConnectOAuthErrorCode never returns raw messages", () => {
  assert.equal(
    merchantConnectOAuthErrorCode(new Error("Invalid or expired OAuth state")),
    "invalid_oauth_state",
  );
  assert.equal(
    merchantConnectOAuthErrorCode(new Error("OAuth state expired")),
    "oauth_state_expired",
  );
  assert.equal(
    merchantConnectOAuthErrorCode(
      new Error("Stripe POST /v1/oauth/token failed (400): bad code"),
    ),
    "oauth_exchange_failed",
  );
  assert.equal(
    merchantConnectOAuthErrorCode(new Error("secret sk_live_abc leaked")),
    "oauth_failed",
  );
});

test("sanitizeStripeOAuthProviderError allowlists Stripe codes", () => {
  assert.equal(sanitizeStripeOAuthProviderError("access_denied"), "access_denied");
  assert.equal(
    sanitizeStripeOAuthProviderError("totally_weird<script>"),
    "oauth_denied",
  );
  assert.equal(sanitizeStripeOAuthProviderError(""), "missing_oauth_params");
  assert.equal(sanitizeStripeOAuthProviderError("   "), "missing_oauth_params");
});

test("paymentsTabErrorMessage ignores free-form phishing text", () => {
  assert.equal(paymentsTabErrorMessage("access_denied"), "Stripe connection was cancelled.");
  assert.equal(
    paymentsTabErrorMessage(
      "Your Stripe account was suspended. Re-verify at https://evil.example",
    ),
    null,
  );
  assert.equal(paymentsTabErrorMessage(null), null);
});

test("resolveConnectWebhookSecret requires Connect secret and rejects invalid", (t) => {
  const prevConnect = process.env.STRIPE_CONNECT_WEBHOOK_SECRET;
  const prevPlatform = process.env.STRIPE_WEBHOOK_SECRET;
  t.after(() => {
    if (prevConnect === undefined) delete process.env.STRIPE_CONNECT_WEBHOOK_SECRET;
    else process.env.STRIPE_CONNECT_WEBHOOK_SECRET = prevConnect;
    if (prevPlatform === undefined) delete process.env.STRIPE_WEBHOOK_SECRET;
    else process.env.STRIPE_WEBHOOK_SECRET = prevPlatform;
  });

  process.env.STRIPE_WEBHOOK_SECRET = "whsec_platform";
  delete process.env.STRIPE_CONNECT_WEBHOOK_SECRET;
  assert.throws(
    () => resolveConnectWebhookSecret(),
    /STRIPE_CONNECT_WEBHOOK_SECRET is required/,
  );

  process.env.STRIPE_CONNECT_WEBHOOK_SECRET = "whsec_connect";
  assert.equal(resolveConnectWebhookSecret(), "whsec_connect");

  process.env.STRIPE_CONNECT_WEBHOOK_SECRET = "not-a-whsec";
  assert.throws(() => resolveConnectWebhookSecret(), /must start with whsec_/);
});

test("resolveStripeWebhookSecrets returns every configured secret deduplicated", (t) => {
  const prevConnect = process.env.STRIPE_CONNECT_WEBHOOK_SECRET;
  const prevPlatform = process.env.STRIPE_WEBHOOK_SECRET;
  t.after(() => {
    if (prevConnect === undefined) delete process.env.STRIPE_CONNECT_WEBHOOK_SECRET;
    else process.env.STRIPE_CONNECT_WEBHOOK_SECRET = prevConnect;
    if (prevPlatform === undefined) delete process.env.STRIPE_WEBHOOK_SECRET;
    else process.env.STRIPE_WEBHOOK_SECRET = prevPlatform;
  });

  process.env.STRIPE_CONNECT_WEBHOOK_SECRET = "whsec_connect";
  process.env.STRIPE_WEBHOOK_SECRET = "whsec_platform";
  // Platform first: it wins the identical-secret tie-break so a single endpoint
  // configured for both roles still settles top-ups as `platform`.
  assert.deepEqual(resolveStripeWebhookSecrets(), ["whsec_platform", "whsec_connect"]);

  process.env.STRIPE_CONNECT_WEBHOOK_SECRET = "whsec_same";
  process.env.STRIPE_WEBHOOK_SECRET = "whsec_same";
  assert.deepEqual(resolveStripeWebhookSecrets(), ["whsec_same"]);

  delete process.env.STRIPE_CONNECT_WEBHOOK_SECRET;
  assert.deepEqual(resolveStripeWebhookSecrets(), ["whsec_same"]);

  // Bad platform alone still fails closed.
  process.env.STRIPE_WEBHOOK_SECRET = "not-a-whsec";
  assert.throws(() => resolveStripeWebhookSecrets(), /must start with whsec_/);

  // Valid Connect + malformed platform: keep Connect usable (don't 503 everything).
  process.env.STRIPE_CONNECT_WEBHOOK_SECRET = "whsec_connect";
  process.env.STRIPE_WEBHOOK_SECRET = "not-a-whsec";
  assert.deepEqual(resolveStripeWebhookSecrets(), ["whsec_connect"]);

  // Valid platform + malformed Connect: keep platform usable.
  process.env.STRIPE_CONNECT_WEBHOOK_SECRET = "not-a-whsec";
  process.env.STRIPE_WEBHOOK_SECRET = "whsec_platform";
  assert.deepEqual(resolveStripeWebhookSecrets(), ["whsec_platform"]);

  delete process.env.STRIPE_CONNECT_WEBHOOK_SECRET;
  delete process.env.STRIPE_WEBHOOK_SECRET;
  assert.throws(() => resolveStripeWebhookSecrets(), /STRIPE_WEBHOOK_SECRET is required/);
});
