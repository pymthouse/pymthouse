import test from "node:test";
import assert from "node:assert/strict";
import type { OpenMeter } from "@openmeter/sdk";

import {
  ensureFreeBillingProfile,
  resetFreeBillingProfileCacheForTests,
} from "./billing-profiles";

function openMeterTestClient(mock: object): OpenMeter {
  return mock as OpenMeter;
}

test("ensureFreeBillingProfile returns OPENMETER_FREE_BILLING_PROFILE_ID when set", async () => {
  resetFreeBillingProfileCacheForTests();
  const previous = process.env.OPENMETER_FREE_BILLING_PROFILE_ID;
  process.env.OPENMETER_FREE_BILLING_PROFILE_ID = "profile_from_env";
  try {
    const profileId = await ensureFreeBillingProfile();
    assert.equal(profileId, "profile_from_env");
  } finally {
    if (previous === undefined) {
      delete process.env.OPENMETER_FREE_BILLING_PROFILE_ID;
    } else {
      process.env.OPENMETER_FREE_BILLING_PROFILE_ID = previous;
    }
    resetFreeBillingProfileCacheForTests();
  }
});

test("ensureFreeBillingProfile reuses existing sandbox billing profile", async () => {
  resetFreeBillingProfileCacheForTests();
  const previous = process.env.OPENMETER_FREE_BILLING_PROFILE_ID;
  delete process.env.OPENMETER_FREE_BILLING_PROFILE_ID;

  const sandboxAppId = "app_sandbox_1";
  let createCalls = 0;
  const client = openMeterTestClient({
    apps: {
      list: async () => ({
        items: [{ id: sandboxAppId, type: "sandbox" }],
      }),
    },
    billing: {
      profiles: {
        list: async () => ({
          items: [
            {
              id: "profile_sandbox_existing",
              apps: {
                tax: sandboxAppId,
                invoicing: sandboxAppId,
                payment: sandboxAppId,
              },
            },
          ],
        }),
        create: async () => {
          createCalls += 1;
          return { id: "profile_should_not_be_created" };
        },
      },
    },
  });

  try {
    const profileId = await ensureFreeBillingProfile(client);
    assert.equal(profileId, "profile_sandbox_existing");
    assert.equal(createCalls, 0);
  } finally {
    if (previous === undefined) {
      delete process.env.OPENMETER_FREE_BILLING_PROFILE_ID;
    } else {
      process.env.OPENMETER_FREE_BILLING_PROFILE_ID = previous;
    }
    resetFreeBillingProfileCacheForTests();
  }
});

test("ensureFreeBillingProfile creates sandbox billing profile when missing", async () => {
  resetFreeBillingProfileCacheForTests();
  const previous = process.env.OPENMETER_FREE_BILLING_PROFILE_ID;
  delete process.env.OPENMETER_FREE_BILLING_PROFILE_ID;

  const sandboxAppId = "app_sandbox_1";
  const client = openMeterTestClient({
    apps: {
      list: async () => ({
        items: [{ id: sandboxAppId, type: "sandbox" }],
      }),
    },
    billing: {
      profiles: {
        list: async () => ({ items: [] }),
        create: async (body: { apps?: { tax?: string } }) => {
          assert.equal(body.apps?.tax, sandboxAppId);
          return { id: "profile_sandbox_created" };
        },
      },
    },
  });

  try {
    const profileId = await ensureFreeBillingProfile(client);
    assert.equal(profileId, "profile_sandbox_created");
    const cachedAgain = await ensureFreeBillingProfile(client);
    assert.equal(cachedAgain, "profile_sandbox_created");
  } finally {
    if (previous === undefined) {
      delete process.env.OPENMETER_FREE_BILLING_PROFILE_ID;
    } else {
      process.env.OPENMETER_FREE_BILLING_PROFILE_ID = previous;
    }
    resetFreeBillingProfileCacheForTests();
  }
});
