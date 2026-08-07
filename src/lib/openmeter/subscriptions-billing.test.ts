import test from "node:test";
import assert from "node:assert/strict";

import {
  defaultSubscriptionChangeTiming,
  neonSubscriptionStatusAfterPlanChange,
  planRequiresPaymentMethod,
  shouldApplyFreeBillingProfileForCheckout,
} from "./subscriptions-billing";

test("planRequiresPaymentMethod is false for free/starter/network", () => {
  assert.equal(
    planRequiresPaymentMethod({ type: "free", priceAmount: "10" }),
    false,
  );
  assert.equal(
    planRequiresPaymentMethod({
      type: "subscription",
      priceAmount: "10",
      isStarterDefault: true,
    }),
    false,
  );
  assert.equal(
    planRequiresPaymentMethod({
      type: "subscription",
      priceAmount: "10",
      isNetworkDefault: true,
    }),
    false,
  );
});

test("planRequiresPaymentMethod is true for paid subscription and pay-per-use", () => {
  assert.equal(
    planRequiresPaymentMethod({ type: "subscription", priceAmount: "9.99" }),
    true,
  );
  assert.equal(
    planRequiresPaymentMethod({ type: "subscription", priceAmount: "0" }),
    false,
  );
  // Usage plans are $0 flat but still need a card for threshold auto-debit.
  assert.equal(
    planRequiresPaymentMethod({ type: "usage", priceAmount: "0" }),
    true,
  );
  assert.equal(
    planRequiresPaymentMethod({ type: "usage", priceAmount: "9.99" }),
    true,
  );
});

test("defaultSubscriptionChangeTiming upgrades immediate, else next cycle", () => {
  assert.equal(
    defaultSubscriptionChangeTiming({
      currentPriceAmount: "5",
      targetPriceAmount: "20",
    }),
    "immediate",
  );
  assert.equal(
    defaultSubscriptionChangeTiming({
      currentPriceAmount: "20",
      targetPriceAmount: "5",
    }),
    "next_billing_cycle",
  );
  assert.equal(
    defaultSubscriptionChangeTiming({
      currentPriceAmount: "10",
      targetPriceAmount: "10",
    }),
    "next_billing_cycle",
  );
  assert.equal(
    defaultSubscriptionChangeTiming({
      currentPriceAmount: null,
      targetPriceAmount: "1",
    }),
    "immediate",
  );
});

test("neonSubscriptionStatusAfterPlanChange is pending when checkout is required", () => {
  assert.equal(
    neonSubscriptionStatusAfterPlanChange({
      checkoutUrl: "https://checkout.stripe.com/c/pay_test",
    }),
    "pending",
  );
  assert.equal(neonSubscriptionStatusAfterPlanChange({}), "active");
  assert.equal(
    neonSubscriptionStatusAfterPlanChange({ checkoutUrl: undefined }),
    "active",
  );
});

test("merchant Checkout retains its Custom Invoicing billing profile", () => {
  assert.equal(
    shouldApplyFreeBillingProfileForCheckout({
      isMerchantBilling: true,
      needsPaymentMethod: true,
      defaultPaymentMethodId: null,
    }),
    false,
  );
  assert.equal(
    shouldApplyFreeBillingProfileForCheckout({
      isMerchantBilling: false,
      needsPaymentMethod: true,
      defaultPaymentMethodId: null,
    }),
    true,
  );
});

test("scheduled status is never a /change target for checkout routing", async () => {
  const { isScheduledSubscriptionStatus, isLiveSubscriptionStatus } =
    await import("./subscription-state");
  // Contract: checkout must DELETE scheduled rows, not call /change.
  assert.equal(isScheduledSubscriptionStatus("scheduled"), true);
  assert.equal(isLiveSubscriptionStatus("scheduled"), false);
  assert.equal(isScheduledSubscriptionStatus("pending"), true);
  assert.equal(isLiveSubscriptionStatus("pending"), false);
});

test("cancel-at-period-end starter still occupies the customer for create", async () => {
  const { isOccupyingCanceledSubscription } = await import("./subscription-state");
  // Matches staging Konnect 409: starter activeTo=2026-09-07 blocks create.
  assert.equal(
    isOccupyingCanceledSubscription(
      {
        status: "canceled",
        activeTo: "2026-09-07T17:35:18.109927Z",
      },
      Date.parse("2026-08-07T21:25:20.000Z"),
    ),
    true,
  );
});
