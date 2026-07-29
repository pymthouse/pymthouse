import assert from "node:assert/strict";
import test from "node:test";
import type { OpenMeter } from "@openmeter/sdk";
import {
  ensureOwnersBillingProfile,
  resetOwnersBillingProfileCacheForTests,
} from "./billing-profiles";
import { __testSetHostedOpenMeterClient, resetHostedOpenMeterClientForTests } from "./client";

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
