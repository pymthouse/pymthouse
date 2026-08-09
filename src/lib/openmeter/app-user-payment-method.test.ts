import assert from "node:assert/strict";
import test from "node:test";

import {
  appUserPaymentMethodRequiresMerchantConnect,
  createAppUserPaymentMethodCheckout,
  listAppUserPaymentMethods,
  resolveAppUserCheckoutReturnUrl,
  restoreAppUserBillingProfileForCheckoutSession,
} from "./app-user-payment-method";

test("listAppUserPaymentMethods returns [] for blank ids", async () => {
  assert.deepEqual(
    await listAppUserPaymentMethods({
      clientId: "",
      externalUserId: "u1",
    }),
    [],
  );
  assert.deepEqual(
    await listAppUserPaymentMethods({
      clientId: "app_1",
      externalUserId: "  ",
    }),
    [],
  );
});

test("restoreAppUserBillingProfileForCheckoutSession ignores blank session ids", async () => {
  assert.equal(await restoreAppUserBillingProfileForCheckoutSession(""), false);
  assert.equal(await restoreAppUserBillingProfileForCheckoutSession("   "), false);
});

test("createAppUserPaymentMethodCheckout requires ids", async () => {
  await assert.rejects(
    () =>
      createAppUserPaymentMethodCheckout({
        clientId: "  ",
        externalUserId: "user_1",
      }),
    /clientId and externalUserId are required/,
  );
});

test("appUserPaymentMethodRequiresMerchantConnect for merchant and connect-only", (t) => {
  const previous = process.env.STRIPE_CONNECT_PAYMENTS_ONLY;
  t.after(() => {
    if (previous === undefined) {
      delete process.env.STRIPE_CONNECT_PAYMENTS_ONLY;
    } else {
      process.env.STRIPE_CONNECT_PAYMENTS_ONLY = previous;
    }
  });
  delete process.env.STRIPE_CONNECT_PAYMENTS_ONLY;

  assert.equal(appUserPaymentMethodRequiresMerchantConnect(null), false);
  assert.equal(
    appUserPaymentMethodRequiresMerchantConnect({
      billingMode: "owner_rollup",
    } as never),
    false,
  );
  assert.equal(
    appUserPaymentMethodRequiresMerchantConnect({
      billingMode: "merchant",
    } as never),
    true,
  );
  assert.equal(
    appUserPaymentMethodRequiresMerchantConnect({
      billingMode: "owner_rollup",
      connectPaymentsOnly: true,
    } as never),
    true,
  );

  process.env.STRIPE_CONNECT_PAYMENTS_ONLY = "1";
  assert.equal(
    appUserPaymentMethodRequiresMerchantConnect({
      billingMode: "owner_rollup",
      connectPaymentsOnly: false,
    } as never),
    true,
  );
});

test("resolveAppUserCheckoutReturnUrl accepts https and localhost http", () => {
  const fallback = "https://app.example/apps/app_1/payments";
  assert.equal(
    resolveAppUserCheckoutReturnUrl(
      "https://partner.example/done",
      fallback,
    ),
    "https://partner.example/done",
  );
  assert.equal(
    resolveAppUserCheckoutReturnUrl("http://localhost:3000/done", fallback),
    "http://localhost:3000/done",
  );
  assert.equal(
    resolveAppUserCheckoutReturnUrl("http://evil.example/phish", fallback),
    fallback,
  );
  assert.equal(resolveAppUserCheckoutReturnUrl("not-a-url", fallback), fallback);
  assert.equal(resolveAppUserCheckoutReturnUrl(undefined, fallback), fallback);
});

test("appUserHasChargeablePaymentMethod denies blank ids", async () => {
  const { appUserHasChargeablePaymentMethod } = await import(
    "./app-user-payment-method"
  );
  assert.equal(
    await appUserHasChargeablePaymentMethod({
      clientId: "",
      externalUserId: "u1",
    }),
    false,
  );
  assert.equal(
    await appUserHasChargeablePaymentMethod({
      clientId: "app_1",
      externalUserId: " ",
    }),
    false,
  );
});
