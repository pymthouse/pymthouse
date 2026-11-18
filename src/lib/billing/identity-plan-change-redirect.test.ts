import assert from "node:assert/strict";
import test from "node:test";

import { identityPlanChangeCheckoutRedirectUrl } from "./identity-plan-change-redirect";

test("PM-gated change redirects even when current subscriptionId is present", () => {
  // Mirrors changeAppUserSubscriptionPlan early return: card Checkout plus the
  // live subscription id (plan has not changed yet).
  const url = identityPlanChangeCheckoutRedirectUrl({
    subscriptionId: "sub_current",
    checkoutUrl: "https://checkout.stripe.com/c/pay/cs_test_pm",
  });
  assert.equal(url, "https://checkout.stripe.com/c/pay/cs_test_pm");
});

test("successful in-place change with no Checkout does not redirect", () => {
  assert.equal(
    identityPlanChangeCheckoutRedirectUrl({
      subscriptionId: "sub_live",
      checkoutUrl: undefined,
    }),
    null,
  );
});

test("successUrl masquerading as checkoutUrl is not a redirect target", () => {
  assert.equal(
    identityPlanChangeCheckoutRedirectUrl({
      subscriptionId: "sub_live",
      checkoutUrl: "https://app.example/apps/x/identities/y",
    }),
    null,
  );
});

test("empty or missing body does not redirect", () => {
  assert.equal(identityPlanChangeCheckoutRedirectUrl(null), null);
  assert.equal(identityPlanChangeCheckoutRedirectUrl({}), null);
  assert.equal(
    identityPlanChangeCheckoutRedirectUrl({
      subscriptionId: "",
      checkoutUrl: "",
    }),
    null,
  );
});
