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

test("planRequiresPaymentMethod is true only for paid subscription flat fee", () => {
  assert.equal(
    planRequiresPaymentMethod({ type: "subscription", priceAmount: "9.99" }),
    true,
  );
  assert.equal(
    planRequiresPaymentMethod({ type: "subscription", priceAmount: "0" }),
    false,
  );
  assert.equal(
    planRequiresPaymentMethod({ type: "usage", priceAmount: "9.99" }),
    false,
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
