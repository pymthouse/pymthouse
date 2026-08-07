import assert from "node:assert/strict";
import test from "node:test";

import {
  createAppUserPaymentMethodCheckout,
  listAppUserPaymentMethods,
  resolveAppUserCheckoutReturnUrl,
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
