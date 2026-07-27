import test from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import {
  merchantConnectOAuthErrorCode,
  parseStripeAccountUpdated,
  paymentsTabErrorMessage,
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
