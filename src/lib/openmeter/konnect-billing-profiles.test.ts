import test from "node:test";
import assert from "node:assert/strict";

import {
  buildKonnectCreateBillingProfileBody,
  createKonnectBillingProfile,
  getKonnectApp,
  isKonnectStripeAppReady,
  isKonnectStripeAppUnauthorized,
  konnectAppType,
  listKonnectApps,
  listKonnectBillingProfiles,
  resolveKonnectStripeAppId,
  selectReadyKonnectStripeApp,
  updateKonnectBillingProfileCollection,
  updateKonnectBillingProfileProgressiveBilling,
} from "./konnect-billing-profiles";
import {
  createStripeOAuthState,
  StripeOAuthUnavailableError,
} from "./stripe-app-install";

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
  assert.deepEqual(body.workflow.invoicing, {
    auto_advance: true,
    draft_period: "P0D",
    progressive_billing: true,
  });
  assert.deepEqual(body.workflow.payment, {
    collection_method: "charge_automatically",
  });
  assert.equal(body.workflow.collection?.alignment.type, "anchored");
  assert.equal(
    body.workflow.collection?.alignment.recurring_period.interval,
    "P1D",
  );
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

function withKonnectEnv(t: test.TestContext): void {
  const savedUrl = process.env.OPENMETER_URL;
  const savedKey = process.env.OPENMETER_API_KEY;
  const savedMode = process.env.OPENMETER_ROUTE_MODE;
  const savedStripeApp = process.env.OPENMETER_STRIPE_APP_ID;
  process.env.OPENMETER_URL = "https://us.api.konghq.com/v3/openmeter";
  process.env.OPENMETER_API_KEY = "km_test_key";
  process.env.OPENMETER_ROUTE_MODE = "hosted";
  delete process.env.OPENMETER_STRIPE_APP_ID;
  t.after(() => {
    if (savedUrl === undefined) delete process.env.OPENMETER_URL;
    else process.env.OPENMETER_URL = savedUrl;
    if (savedKey === undefined) delete process.env.OPENMETER_API_KEY;
    else process.env.OPENMETER_API_KEY = savedKey;
    if (savedMode === undefined) delete process.env.OPENMETER_ROUTE_MODE;
    else process.env.OPENMETER_ROUTE_MODE = savedMode;
    if (savedStripeApp === undefined) delete process.env.OPENMETER_STRIPE_APP_ID;
    else process.env.OPENMETER_STRIPE_APP_ID = savedStripeApp;
  });
}

test("isKonnectStripeAppUnauthorized detects unauthorized stripe apps", () => {
  assert.equal(
    isKonnectStripeAppUnauthorized({ id: "x", type: "stripe", status: "unauthorized" }),
    true,
  );
  assert.equal(
    isKonnectStripeAppUnauthorized({ id: "x", type: "stripe", status: "ready" }),
    false,
  );
});

test("getKonnectApp returns null on 404 and app on success", async (t) => {
  withKonnectEnv(t);
  let calls = 0;
  t.mock.method(globalThis, "fetch", async (input: RequestInfo | URL) => {
    calls += 1;
    const url = String(input);
    if (url.includes("/apps/missing")) {
      return new Response("gone", { status: 404 });
    }
    return new Response(
      JSON.stringify({ id: "app_ready", type: "stripe", status: "ready" }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  });

  assert.equal(await getKonnectApp("missing"), null);
  assert.deepEqual(await getKonnectApp("app_ready"), {
    id: "app_ready",
    type: "stripe",
    status: "ready",
  });
  assert.equal(calls, 2);
});

test("listKonnectApps and listKonnectBillingProfiles page until exhausted", async (t) => {
  withKonnectEnv(t);
  t.mock.method(globalThis, "fetch", async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("/apps?")) {
      return new Response(
        JSON.stringify({
          data: [{ id: "a1", type: "stripe", status: "ready" }],
          meta: { page: { number: 1, size: 100, total: 1 } },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }
    if (url.includes("/profiles?")) {
      return new Response(
        JSON.stringify({
          data: [
            {
              id: "p1",
              name: "tenant",
              apps: { payment: { id: "a1" }, tax: { id: "a1" }, invoicing: { id: "a1" } },
            },
          ],
          meta: { page: { number: 1, size: 100, total: 1 } },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }
    throw new Error(`Unexpected fetch: ${url}`);
  });

  const apps = await listKonnectApps();
  assert.equal(apps.length, 1);
  assert.equal(apps[0]!.id, "a1");

  const profiles = await listKonnectBillingProfiles();
  assert.equal(profiles.length, 1);
  assert.equal(profiles[0]!.id, "p1");
});

test("resolveKonnectStripeAppId uses OPENMETER_STRIPE_APP_ID when ready", async (t) => {
  withKonnectEnv(t);
  process.env.OPENMETER_STRIPE_APP_ID = "01STRIPEOVERRIDE000000001";
  t.mock.method(globalThis, "fetch", async (input: RequestInfo | URL) => {
    assert.match(String(input), /\/apps\/01STRIPEOVERRIDE000000001$/);
    return new Response(
      JSON.stringify({
        id: "01STRIPEOVERRIDE000000001",
        type: "stripe",
        status: "ready",
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  });

  assert.equal(await resolveKonnectStripeAppId(), "01STRIPEOVERRIDE000000001");
});

test("resolveKonnectStripeAppId picks ready app from list", async (t) => {
  withKonnectEnv(t);
  t.mock.method(globalThis, "fetch", async (input: RequestInfo | URL) => {
    assert.match(String(input), /\/apps\?/);
    return new Response(
      JSON.stringify({
        data: [
          { id: "sandbox", type: "sandbox", status: "ready" },
          { id: "stripe_ready", type: "stripe", status: "ready" },
        ],
        meta: { page: { number: 1, size: 100, total: 2 } },
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  });

  assert.equal(await resolveKonnectStripeAppId(), "stripe_ready");
});

test("resolveKonnectStripeAppId errors when only unauthorized Stripe app exists", async (t) => {
  withKonnectEnv(t);
  t.mock.method(globalThis, "fetch", async () =>
    new Response(
      JSON.stringify({
        data: [{ id: "stripe_bad", type: "stripe", status: "unauthorized" }],
        meta: { page: { number: 1, size: 100, total: 1 } },
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    ),
  );

  await assert.rejects(
    () => resolveKonnectStripeAppId(),
    /installed but unauthorized/,
  );
});

test("createKonnectBillingProfile posts profile body", async (t) => {
  withKonnectEnv(t);
  t.mock.method(globalThis, "fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    assert.equal(init?.method, "POST");
    assert.match(String(input), /\/profiles$/);
    assert.match(String(init?.body ?? ""), /"progressive_billing":false/);
    return new Response(JSON.stringify({ id: "prof_new" }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  });

  const id = await createKonnectBillingProfile({
    clientId: "app_1",
    openmeterStripeAppId: "stripe_1",
    name: "Tenant",
    progressiveBilling: false,
  });
  assert.equal(id, "prof_new");
});

test("updateKonnectBillingProfileProgressiveBilling patches workflow", async (t) => {
  withKonnectEnv(t);
  const calls: Array<{ method: string; body: string }> = [];
  t.mock.method(globalThis, "fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    const body = String(init?.body ?? "");
    calls.push({ method, body });
    if (method === "GET") {
      return new Response(
        JSON.stringify({
          id: "prof_1",
          created_at: "t0",
          updated_at: "t1",
          apps: { tax: { id: "a" } },
          workflow: { invoicing: { auto_advance: true } },
          name: "Tenant",
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }
    assert.equal(method, "PUT");
    assert.match(body, /"progressive_billing":true/);
    assert.doesNotMatch(body, /"created_at"/);
    return new Response("{}", {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  });

  await updateKonnectBillingProfileProgressiveBilling({
    profileId: "prof_1",
    progressiveBilling: true,
  });
  assert.equal(calls.length, 2);
});

test("updateKonnectBillingProfileCollection strips supplier.id and sends P1D", async (t) => {
  withKonnectEnv(t);
  let putBody = "";
  t.mock.method(globalThis, "fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    if (method === "GET") {
      return new Response(
        JSON.stringify({
          id: "prof_1",
          created_at: "t0",
          updated_at: "t1",
          apps: { tax: { id: "a" } },
          // Konnect GET bodies carry response-only supplier.id, which the
          // update schema rejects with an allOf error when echoed back.
          supplier: { id: "", name: "Tenant", addresses: {} },
          workflow: { collection: { alignment: { type: "subscription" } } },
          name: "Tenant",
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }
    putBody = String(init?.body ?? "");
    return new Response("{}", {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  });

  await updateKonnectBillingProfileCollection({
    profileId: "prof_1",
    anchor: new Date("2026-03-04T05:06:07.000Z"),
  });
  const body = JSON.parse(putBody);
  assert.equal("id" in body.supplier, false);
  assert.equal(body.supplier.name, "Tenant");
  assert.deepEqual(body.workflow.collection, {
    alignment: {
      type: "anchored",
      recurring_period: {
        interval: "P1D",
        anchor: "2026-03-04T05:06:07.000Z",
      },
    },
  });
});

test("updateKonnectBillingProfileCollection refuses deleted profiles", async (t) => {
  withKonnectEnv(t);
  t.mock.method(globalThis, "fetch", async () => {
    return new Response(
      JSON.stringify({
        id: "prof_gone",
        deleted_at: "2026-06-27T00:00:41.255302Z",
        workflow: {},
        name: "Tenant",
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  });

  await assert.rejects(
    updateKonnectBillingProfileCollection({ profileId: "prof_gone" }),
    /is deleted/,
  );
});
