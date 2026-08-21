import assert from "node:assert/strict";
import test from "node:test";
import type { OpenMeter } from "@openmeter/sdk";
import {
  assignMerchantCustomInvoicingProfile,
  ensureOwnersBillingProfile,
  isAppBillingReady,
  resetOwnersBillingProfileCacheForTests,
} from "./billing-profiles";
import { __testSetHostedOpenMeterClient, resetHostedOpenMeterClientForTests } from "./client";

test("isAppBillingReady requires Stripe app id and billing profile id", () => {
  assert.equal(isAppBillingReady(null), false);
  assert.equal(
    isAppBillingReady({
      openmeterStripeAppId: "app",
      openmeterBillingProfileId: null,
    }),
    false,
  );
  assert.equal(
    isAppBillingReady({
      openmeterStripeAppId: "app",
      openmeterBillingProfileId: "profile",
    }),
    true,
  );
});

test("ensureOwnersBillingProfile returns OPENMETER_OWNERS_BILLING_PROFILE_ID when set", async (t) => {
  resetOwnersBillingProfileCacheForTests();
  const previous = process.env.OPENMETER_OWNERS_BILLING_PROFILE_ID;
  process.env.OPENMETER_OWNERS_BILLING_PROFILE_ID = "profile_owners_env";
  t.after(() => {
    if (previous === undefined) delete process.env.OPENMETER_OWNERS_BILLING_PROFILE_ID;
    else process.env.OPENMETER_OWNERS_BILLING_PROFILE_ID = previous;
    resetOwnersBillingProfileCacheForTests();
  });

  const profileId = await ensureOwnersBillingProfile();
  assert.equal(profileId, "profile_owners_env");
});

test("ensureOwnersBillingProfile reuses existing profile by name", async (t) => {
  resetOwnersBillingProfileCacheForTests();
  const previous = process.env.OPENMETER_OWNERS_BILLING_PROFILE_ID;
  const previousUrl = process.env.OPENMETER_URL;
  delete process.env.OPENMETER_OWNERS_BILLING_PROFILE_ID;
  process.env.OPENMETER_URL = "http://127.0.0.1:48888";

  t.after(() => {
    if (previous === undefined) delete process.env.OPENMETER_OWNERS_BILLING_PROFILE_ID;
    else process.env.OPENMETER_OWNERS_BILLING_PROFILE_ID = previous;
    process.env.OPENMETER_URL = previousUrl;
    resetOwnersBillingProfileCacheForTests();
    resetHostedOpenMeterClientForTests();
  });

  const client = {
    billing: {
      profiles: {
        list: async () => ({
          items: [{ id: "prof_owners", name: "pymthouse-owners" }],
        }),
        create: async () => {
          throw new Error("should not create");
        },
      },
    },
    apps: {
      list: async () => ({ items: [{ id: "stripe_1", type: "stripe" }] }),
    },
  } as unknown as OpenMeter;

  __testSetHostedOpenMeterClient(client);
  const profileId = await ensureOwnersBillingProfile(client);
  assert.equal(profileId, "prof_owners");
});

test("ensureOwnersBillingProfile creates Stripe profile when missing", async (t) => {
  resetOwnersBillingProfileCacheForTests();
  const previous = process.env.OPENMETER_OWNERS_BILLING_PROFILE_ID;
  const previousUrl = process.env.OPENMETER_URL;
  delete process.env.OPENMETER_OWNERS_BILLING_PROFILE_ID;
  process.env.OPENMETER_URL = "http://127.0.0.1:48888";

  t.after(() => {
    if (previous === undefined) delete process.env.OPENMETER_OWNERS_BILLING_PROFILE_ID;
    else process.env.OPENMETER_OWNERS_BILLING_PROFILE_ID = previous;
    process.env.OPENMETER_URL = previousUrl;
    resetOwnersBillingProfileCacheForTests();
    resetHostedOpenMeterClientForTests();
  });

  let createdApps: unknown;
  const client = {
    billing: {
      profiles: {
        list: async () => ({ items: [] }),
        create: async (body: { name: string; apps: unknown }) => {
          createdApps = body.apps;
          assert.equal(body.name, "pymthouse-owners");
          return { id: "prof_new_owners" };
        },
      },
    },
    apps: {
      list: async () => ({ items: [{ id: "stripe_app", type: "stripe" }] }),
    },
  } as unknown as OpenMeter;

  __testSetHostedOpenMeterClient(client);
  const profileId = await ensureOwnersBillingProfile(client);
  assert.equal(profileId, "prof_new_owners");
  assert.deepEqual(createdApps, {
    tax: "stripe_app",
    invoicing: "stripe_app",
    payment: "stripe_app",
  });
  const cachedAgain = await ensureOwnersBillingProfile(client);
  assert.equal(cachedAgain, "prof_new_owners");
});

test("assignMerchantCustomInvoicingProfile pins via the Konnect billing route", async (t) => {
  const savedUrl = process.env.OPENMETER_URL;
  const savedKey = process.env.OPENMETER_API_KEY;
  const savedMode = process.env.OPENMETER_ROUTE_MODE;
  process.env.OPENMETER_URL = "https://us.api.konghq.com/v3/openmeter";
  process.env.OPENMETER_API_KEY = "km_test_key";
  process.env.OPENMETER_ROUTE_MODE = "hosted";
  t.after(() => {
    if (savedUrl === undefined) delete process.env.OPENMETER_URL;
    else process.env.OPENMETER_URL = savedUrl;
    if (savedKey === undefined) delete process.env.OPENMETER_API_KEY;
    else process.env.OPENMETER_API_KEY = savedKey;
    if (savedMode === undefined) delete process.env.OPENMETER_ROUTE_MODE;
    else process.env.OPENMETER_ROUTE_MODE = savedMode;
    resetHostedOpenMeterClientForTests();
  });

  const calls: Array<{ url: string; method: string; body: string }> = [];
  t.mock.method(globalThis, "fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    calls.push({ url: String(input), method, body: String(init?.body ?? "") });
    return new Response(
      JSON.stringify({ billing_profile: { id: "prof_merchant" } }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  });

  // The SDK override is a silent no-op on Konnect, so a client that throws on
  // it proves the merchant pin never takes that path.
  const client = {
    billing: {
      customers: {
        createOverride: async () => {
          throw new Error("must not use the SDK override on Konnect");
        },
      },
    },
  } as unknown as OpenMeter;

  const profileId = await assignMerchantCustomInvoicingProfile({
    client,
    customerId: "cust_m1",
    billingProfileId: "prof_merchant",
  });

  assert.equal(profileId, "prof_merchant");
  const put = calls.find((c) => c.method === "PUT");
  assert.ok(put, "expected a PUT to the Konnect customer billing route");
  assert.match(put.url, /\/customers\/cust_m1\/billing$/);
  assert.deepEqual(JSON.parse(put.body), {
    billing_profile: { id: "prof_merchant" },
  });
});

test("persistMerchantBillingProfileIdIfMissing writes only when unset", async () => {
  const { persistMerchantBillingProfileIdIfMissing } = await import(
    "./billing-profiles"
  );
  const writes: Array<{ clientId: string; profileId: string }> = [];
  const upsert = async (
    clientId: string,
    values: { openmeterMerchantBillingProfileId?: string | null },
  ) => {
    writes.push({
      clientId,
      profileId: values.openmeterMerchantBillingProfileId ?? "",
    });
  };

  assert.equal(
    await persistMerchantBillingProfileIdIfMissing(
      "app_1",
      "already_set",
      "prof_env",
      upsert as never,
    ),
    false,
  );
  assert.deepEqual(writes, []);

  assert.equal(
    await persistMerchantBillingProfileIdIfMissing(
      "app_1",
      "  ",
      "prof_env",
      upsert as never,
    ),
    true,
  );
  assert.deepEqual(writes, [{ clientId: "app_1", profileId: "prof_env" }]);
});
