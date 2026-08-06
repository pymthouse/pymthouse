import assert from "node:assert/strict";
import test from "node:test";

import {
  createAppUserPaymentMethodCheckout,
  listAppUserPaymentMethods,
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
