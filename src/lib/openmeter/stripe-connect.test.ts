import test from "node:test";
import assert from "node:assert/strict";

import {
  buildStripeConnectInstallUrl,
  connectStripeWithApiKey,
  formatOpenMeterBillingError,
  parseStripeAccountIdFromConflict,
} from "./stripe-connect";

test("parseStripeAccountIdFromConflict extracts acct id from OpenMeter 409", () => {
  const err = new Error(
    "Request failed [409]: conflict error: stripe app already exists with stripe account id: acct_1Tct0f1V1EduUmjw",
  );
  assert.equal(parseStripeAccountIdFromConflict(err), "acct_1Tct0f1V1EduUmjw");
  assert.equal(parseStripeAccountIdFromConflict(new Error("no account")), null);
});

test("buildStripeConnectInstallUrl adds state and pymthouse callback redirect_uri", () => {
  process.env.NEXTAUTH_URL = "http://localhost:3001";
  const url = buildStripeConnectInstallUrl({
    installUrl: "https://openmeter.example/api/v1/marketplace/listings/stripe/install/oauth2",
    clientId: "app_test",
    state: "csrf-state-1",
  });
  const parsed = new URL(url);
  assert.equal(parsed.searchParams.get("state"), "csrf-state-1");
  assert.equal(
    parsed.searchParams.get("redirect_uri"),
    "http://localhost:3001/api/v1/apps/app_test/billing/stripe/callback",
  );
});

test("formatOpenMeterBillingError explains unreachable OpenMeter", () => {
  const previous = process.env.OPENMETER_URL;
  process.env.OPENMETER_URL = "http://127.0.0.1:9999";
  try {
    const message = formatOpenMeterBillingError(new Error("fetch failed: ECONNREFUSED"));
    assert.match(message, /Cannot reach OpenMeter/);
    assert.match(message, /127\.0\.0\.1:9999/);
  } finally {
    if (previous === undefined) {
      delete process.env.OPENMETER_URL;
    } else {
      process.env.OPENMETER_URL = previous;
    }
  }
});

test("formatOpenMeterBillingError explains missing Stripe OAuth on self-hosted", () => {
  const message = formatOpenMeterBillingError(new Error("Request failed [501]: unimplemented"));
  assert.match(message, /Stripe OAuth is not available/);
  assert.match(message, /sk_live_/);
});

test("connectStripeWithApiKey rejects keys that are not sk_", async () => {
  await assert.rejects(
    () =>
      connectStripeWithApiKey({
        clientId: "app_1",
        stripeSecretKey: "rk_live_restricted",
      }),
    /must start with sk_live_ or sk_test_/,
  );
});
