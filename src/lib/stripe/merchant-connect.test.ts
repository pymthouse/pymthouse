import test from "node:test";
import assert from "node:assert/strict";
import {
  connectPaymentsOnlyEnabled,
  isMerchantConnectPaymentsReady,
} from "./merchant-connect";

test("isMerchantConnectPaymentsReady requires account, charges, and details", () => {
  assert.equal(isMerchantConnectPaymentsReady(null), false);
  assert.equal(
    isMerchantConnectPaymentsReady({
      stripeConnectedAccountId: "acct_1",
      stripeChargesEnabled: false,
      stripeDetailsSubmitted: true,
    } as never),
    false,
  );
  assert.equal(
    isMerchantConnectPaymentsReady({
      stripeConnectedAccountId: "  ",
      stripeChargesEnabled: true,
      stripeDetailsSubmitted: true,
    } as never),
    false,
  );
  assert.equal(
    isMerchantConnectPaymentsReady({
      stripeConnectedAccountId: "acct_1",
      stripeChargesEnabled: true,
      stripeDetailsSubmitted: false,
    } as never),
    false,
  );
  assert.equal(
    isMerchantConnectPaymentsReady({
      stripeConnectedAccountId: "acct_1",
      stripeChargesEnabled: true,
      stripeDetailsSubmitted: true,
    } as never),
    true,
  );
});

test("connectPaymentsOnlyEnabled honors env override and config flag", (t) => {
  const previous = process.env.STRIPE_CONNECT_PAYMENTS_ONLY;
  t.after(() => {
    if (previous === undefined) {
      delete process.env.STRIPE_CONNECT_PAYMENTS_ONLY;
    } else {
      process.env.STRIPE_CONNECT_PAYMENTS_ONLY = previous;
    }
  });

  delete process.env.STRIPE_CONNECT_PAYMENTS_ONLY;
  assert.equal(connectPaymentsOnlyEnabled(null), false);
  assert.equal(
    connectPaymentsOnlyEnabled({ connectPaymentsOnly: true } as never),
    true,
  );

  process.env.STRIPE_CONNECT_PAYMENTS_ONLY = "1";
  assert.equal(
    connectPaymentsOnlyEnabled({ connectPaymentsOnly: false } as never),
    true,
  );
});
