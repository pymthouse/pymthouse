import assert from "node:assert/strict";
import test from "node:test";
import type { OpenMeter } from "@openmeter/sdk";
import {
  ensureOwnersBillingProfile,
  getAppBillingConfig,
  isAppBillingReady,
  resetOwnersBillingProfileCacheForTests,
  updateAppBillingProfileSettings,
  upsertAppBillingConfig,
} from "./billing-profiles";
import { __testSetHostedOpenMeterClient, resetHostedOpenMeterClientForTests } from "./client";
import { test as dbTest } from "@/test-utils/db-guard";
import { cleanupTestApp, seedDeveloperAppWithClient } from "@/test-utils/fixtures";

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

dbTest("updateAppBillingProfileSettings creates the config row with platform defaults", async (t) => {
  const app = await seedDeveloperAppWithClient();
  t.after(() => cleanupTestApp(app));

  const result = await updateAppBillingProfileSettings({ clientId: app.clientId });
  assert.equal(result.invoiceThresholdUsdMicros, null);
  assert.equal(typeof result.applicationFeeBps, "number");

  const stored = await getAppBillingConfig(app.clientId);
  assert.equal(stored?.progressiveBilling, result.progressiveBilling);
});

dbTest("updateAppBillingProfileSettings clears an invoice threshold when passed null", async (t) => {
  const app = await seedDeveloperAppWithClient();
  t.after(() => cleanupTestApp(app));
  await upsertAppBillingConfig(app.clientId, {
    invoiceThresholdUsdMicros: "2500000",
  });

  const kept = await updateAppBillingProfileSettings({ clientId: app.clientId });
  assert.equal(kept.invoiceThresholdUsdMicros, "2500000");

  const cleared = await updateAppBillingProfileSettings({
    clientId: app.clientId,
    invoiceThresholdUsdMicros: null,
    applicationFeeBps: 250,
  });
  assert.equal(cleared.invoiceThresholdUsdMicros, null);
  assert.equal(cleared.applicationFeeBps, 250);
});

dbTest("updateAppBillingProfileSettings pushes progressive billing to the OpenMeter profile", async (t) => {
  const app = await seedDeveloperAppWithClient();
  const previousRouteMode = process.env.OPENMETER_ROUTE_MODE;
  process.env.OPENMETER_ROUTE_MODE = "self_hosted";
  t.after(async () => {
    if (previousRouteMode === undefined) delete process.env.OPENMETER_ROUTE_MODE;
    else process.env.OPENMETER_ROUTE_MODE = previousRouteMode;
    resetHostedOpenMeterClientForTests();
    await cleanupTestApp(app);
  });
  await upsertAppBillingConfig(app.clientId, {
    openmeterStripeAppId: "stripe_app",
    openmeterBillingProfileId: "prof_tenant",
    progressiveBilling: false,
  });

  const updates: Array<{ profileId: string; body: unknown }> = [];
  __testSetHostedOpenMeterClient({
    billing: {
      profiles: {
        get: async (profileId: string) => ({
          id: profileId,
          name: "tenant",
          default: false,
          supplier: { name: "PymtHouse" },
          workflow: { collection: { alignment: "subscription" }, invoicing: { autoAdvance: true } },
        }),
        update: async (profileId: string, body: unknown) => {
          updates.push({ profileId, body });
          return { id: profileId };
        },
      },
    },
  } as unknown as OpenMeter);

  const result = await updateAppBillingProfileSettings({
    clientId: app.clientId,
    progressiveBilling: true,
  });
  assert.equal(result.progressiveBilling, true);
  assert.equal(updates.length, 1);
  assert.equal(updates[0]?.profileId, "prof_tenant");
  assert.deepEqual((updates[0]?.body as { workflow: unknown }).workflow, {
    collection: { alignment: "subscription" },
    invoicing: { autoAdvance: true, progressiveBilling: true },
  });
});

dbTest("updateAppBillingProfileSettings rejects a missing OpenMeter profile", async (t) => {
  const app = await seedDeveloperAppWithClient();
  const previousRouteMode = process.env.OPENMETER_ROUTE_MODE;
  process.env.OPENMETER_ROUTE_MODE = "self_hosted";
  t.after(async () => {
    if (previousRouteMode === undefined) delete process.env.OPENMETER_ROUTE_MODE;
    else process.env.OPENMETER_ROUTE_MODE = previousRouteMode;
    resetHostedOpenMeterClientForTests();
    await cleanupTestApp(app);
  });
  await upsertAppBillingConfig(app.clientId, {
    openmeterStripeAppId: "stripe_app",
    openmeterBillingProfileId: "prof_missing",
    progressiveBilling: false,
  });

  __testSetHostedOpenMeterClient({
    billing: { profiles: { get: async () => null } },
  } as unknown as OpenMeter);

  await assert.rejects(
    () =>
      updateAppBillingProfileSettings({
        clientId: app.clientId,
        progressiveBilling: true,
      }),
    /OpenMeter billing profile not found/,
  );
});
