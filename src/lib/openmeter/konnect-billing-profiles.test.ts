import test from "node:test";
import assert from "node:assert/strict";

import {
  buildKonnectCreateBillingProfileBody,
  isKonnectStripeAppReady,
  konnectAppType,
  selectReadyKonnectStripeApp,
} from "./konnect-billing-profiles";
import {
  createStripeOAuthState,
  StripeOAuthUnavailableError,
} from "./stripe-connect";

test("buildKonnectCreateBillingProfileBody uses Konnect snake_case supplier address", () => {
  const body = buildKonnectCreateBillingProfileBody({
    clientId: "app_1",
    stripeAppId: "01G65Z755AFWAKHE12NY0CQ9FH",
    name: "Acme App",
  });

  assert.equal(body.name, "Acme App");
  assert.equal(body.default, false);
  assert.deepEqual(body.supplier, {
    name: "Acme App",
    addresses: {
      billing_address: { country: "US" },
    },
  });
  assert.deepEqual(body.workflow, {
    invoicing: { auto_advance: true, draft_period: "P0D" },
    payment: { collection_method: "charge_automatically" },
  });
  assert.deepEqual(body.apps, {
    tax: { id: "01G65Z755AFWAKHE12NY0CQ9FH" },
    invoicing: { id: "01G65Z755AFWAKHE12NY0CQ9FH" },
    payment: { id: "01G65Z755AFWAKHE12NY0CQ9FH" },
  });
});

test("selectReadyKonnectStripeApp picks first ready stripe app from page data", () => {
  const apps = [
    { id: "01SANDBOX00000000000000001", type: "sandbox", status: "ready" },
    { id: "01STRIPEUNAUTHORIZED000001", type: "stripe", status: "unauthorized" },
    { id: "01G65Z755AFWAKHE12NY0CQ9FH", type: "stripe", status: "ready" },
    { id: "01STRIPESECOND00000000001", type: "stripe", status: "ready" },
  ];

  assert.equal(selectReadyKonnectStripeApp(apps), "01G65Z755AFWAKHE12NY0CQ9FH");
  assert.equal(selectReadyKonnectStripeApp([]), null);
});

test("konnectAppType falls back to definition.type", () => {
  assert.equal(konnectAppType({ id: "x", definition: { type: "stripe" } }), "stripe");
  assert.equal(isKonnectStripeAppReady({ id: "x", definition: { type: "stripe" }, status: "ready" }), true);
});

test("createStripeOAuthState on Konnect throws before marketplace fetch", async (t) => {
  const previousUrl = process.env.OPENMETER_URL;
  const previousMode = process.env.OPENMETER_ROUTE_MODE;
  process.env.OPENMETER_URL = "https://us.api.konghq.com/v3/openmeter";
  process.env.OPENMETER_ROUTE_MODE = "hosted";
  t.after(() => {
    process.env.OPENMETER_URL = previousUrl;
    process.env.OPENMETER_ROUTE_MODE = previousMode;
  });

  const fetchMock = t.mock.method(globalThis, "fetch", async () => {
    throw new Error("marketplace fetch should not run on Konnect");
  });

  await assert.rejects(
    () =>
      createStripeOAuthState({
        clientId: "app_1",
        userId: "user_1",
      }),
    StripeOAuthUnavailableError,
  );
  assert.equal(fetchMock.mock.calls.length, 0);
});
