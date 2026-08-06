import assert from "node:assert/strict";
import { before, beforeEach } from "node:test";
import { eq } from "drizzle-orm";

import { db } from "@/db/index";
import { plans } from "@/db/schema";
import { buildOpenMeterPlanKey } from "@/lib/openmeter/plan-naming";
import { test as dbTest } from "@/test-utils/db-guard";
import {
  cleanupTestApp,
  seedDeveloperAppWithClient,
  type SeededDeveloperApp,
} from "@/test-utils/fixtures";
import { createStubRegistry } from "@/test-utils/module-stubs";

type FakeSubscriptionView = {
  id: string;
  status?: string;
  customerId?: string | null;
  planKey?: string | null;
  planId?: string | null;
};

const CUSTOMER_ID = "cust_app_user";

const created: Array<{ customerId: string; plan: unknown }> = [];
const freeProfileApplied: string[] = [];
let subscriptionsCreate: () => Promise<
  | {
      id?: string;
      status?: string;
      customerId?: string;
      activeFrom?: Date;
      activeTo?: Date;
    }
  | null
> = async () => ({
  id: "sub_created",
  status: "active",
  customerId: CUSTOMER_ID,
  activeFrom: new Date("2026-01-01T00:00:00.000Z"),
});

const fakeClient = {
  subscriptions: {
    create: async (body: { customerId: string; plan: unknown }) => {
      created.push(body);
      return subscriptionsCreate();
    },
  },
};

const stubs = createStubRegistry();

const adminClient = stubs.module("@/lib/openmeter/admin-client", {
  isHostedAdminClientAvailable: (): boolean => true,
  getHostedAdminClient: (): unknown => fakeClient,
});

stubs.module("@/lib/openmeter/billing-profiles", {
  applyFreeBillingProfileToCustomer: async (input: {
    customerId: string;
  }): Promise<void> => {
    freeProfileApplied.push(input.customerId);
  },
});

const customers = stubs.module("@/lib/openmeter/customers", {
  ensureOpenMeterCustomer: async (): Promise<{ id: string }> => ({
    id: CUSTOMER_ID,
  }),
  listOwnedPublicClientIds: async (): Promise<string[]> => [],
});

const plansSync = stubs.module("@/lib/openmeter/plans-sync", {
  buildOpenMeterPlanKey,
  verifyOpenMeterPlanId: async (
    _client: unknown,
    planId: string,
  ): Promise<{ id: string } | null> => ({ id: planId }),
  syncPlanToOpenMeter: async (): Promise<{ ok: boolean; error?: string }> => ({
    ok: true,
  }),
});

const subscriptionRead = stubs.module("@/lib/openmeter/subscription-read", {
  verifyOpenMeterSubscriptionId:
    async (): Promise<FakeSubscriptionView | null> => null,
  findOpenMeterSubscriptionByPlanKey:
    async (): Promise<FakeSubscriptionView | null> => null,
});

const billingIdentity = stubs.module("@/lib/openmeter/billing-identity", {
  resolveOpenMeterBillingIdentity: async (input: {
    clientId: string;
    externalUserId: string;
  }): Promise<{
    customerKey: string;
    isOwner: boolean;
    ownerUserId?: string;
    publicClientId: string;
    developerAppId: string;
  }> => ({
    customerKey: `${input.clientId}:${input.externalUserId}`,
    isOwner: false,
    publicClientId: input.clientId,
    developerAppId: input.clientId,
  }),
});

const ownerStarterPlan = stubs.module("@/lib/openmeter/owner-starter-plan", {
  ensureOwnerStarterSubscription: async (): Promise<{
    openmeterSubscriptionId: string | null;
    planKey: string;
    openmeterPlanId: string;
    created: boolean;
  }> => ({
    openmeterSubscriptionId: "sub_owner",
    planKey: "pymthouse_owner_starter",
    openmeterPlanId: "plan_owner_starter",
    created: true,
  }),
});

let sut: typeof import("@/lib/openmeter/starter-subscription");

before(async () => {
  sut = await import("@/lib/openmeter/starter-subscription");
});

beforeEach(() => {
  stubs.reset();
  created.length = 0;
  freeProfileApplied.length = 0;
  subscriptionsCreate = async () => ({
    id: "sub_created",
    status: "active",
    customerId: CUSTOMER_ID,
    activeFrom: new Date("2026-01-01T00:00:00.000Z"),
  });
  sut.resetStarterPlanSyncedCacheForTests();
});

const conflictError = () => new Error("conflict error: subscription already exists");
const planNotFoundError = () => new Error("plan not found");
const stripeBillingError = () =>
  new Error("customers need a default payment method");

async function seedApp(): Promise<{
  app: SeededDeveloperApp;
  starter: typeof plans.$inferSelect;
}> {
  const app = await seedDeveloperAppWithClient();
  const rows = await db.select().from(plans).where(eq(plans.clientId, app.clientId));
  const starter = rows.find((row) => row.isStarterDefault);
  if (!starter) {
    throw new Error("seeded app has no Starter plan row");
  }
  await db
    .update(plans)
    .set({ openmeterPlanId: `plan_${starter.id}` })
    .where(eq(plans.id, starter.id));
  return { app, starter: { ...starter, openmeterPlanId: `plan_${starter.id}` } };
}

dbTest("ensureStarterPlanSynced returns the local row when OpenMeter is off", async (t) => {
  const { app, starter } = await seedApp();
  t.after(() => cleanupTestApp(app));
  adminClient.isHostedAdminClientAvailable = () => false;

  const synced = await sut.ensureStarterPlanSynced(app.clientId);
  assert.equal(synced.id, starter.id);
});

dbTest("ensureStarterPlanSynced keeps a verified OpenMeter plan id", async (t) => {
  const { app, starter } = await seedApp();
  t.after(() => cleanupTestApp(app));
  let synced = 0;
  plansSync.syncPlanToOpenMeter = async () => {
    synced += 1;
    return { ok: true };
  };

  const result = await sut.ensureStarterPlanSynced(app.clientId);
  assert.equal(result.openmeterPlanId, starter.openmeterPlanId);
  assert.equal(synced, 0);
});

dbTest("ensureStarterPlanSynced re-syncs an unverifiable plan id", async (t) => {
  const { app, starter } = await seedApp();
  t.after(() => cleanupTestApp(app));
  plansSync.verifyOpenMeterPlanId = async () => null;
  plansSync.syncPlanToOpenMeter = async () => {
    await db
      .update(plans)
      .set({ openmeterPlanId: "plan_resynced" })
      .where(eq(plans.id, starter.id));
    return { ok: true };
  };

  const result = await sut.ensureStarterPlanSynced(app.clientId);
  assert.equal(result.openmeterPlanId, "plan_resynced");
});

dbTest("ensureStarterPlanSynced surfaces a failed plan sync", async (t) => {
  const { app } = await seedApp();
  t.after(() => cleanupTestApp(app));
  plansSync.verifyOpenMeterPlanId = async () => null;
  plansSync.syncPlanToOpenMeter = async () => ({
    ok: false,
    error: "konnect rejected the plan body",
  });

  await assert.rejects(
    () => sut.ensureStarterPlanSynced(app.clientId),
    /konnect rejected the plan body/,
  );
});

dbTest("ensureStarterPlanSynced rejects when the plan row disappears", async (t) => {
  const { app, starter } = await seedApp();
  t.after(() => cleanupTestApp(app));
  plansSync.verifyOpenMeterPlanId = async () => null;
  plansSync.syncPlanToOpenMeter = async () => {
    await db.delete(plans).where(eq(plans.id, starter.id));
    return { ok: true };
  };

  await assert.rejects(
    () => sut.ensureStarterPlanSynced(app.clientId),
    /Starter plan row missing after OpenMeter sync/,
  );
});

dbTest("ensureStarterSubscriptionForAppUser returns the local plan when OpenMeter is off", async (t) => {
  const { app, starter } = await seedApp();
  t.after(() => cleanupTestApp(app));
  adminClient.isHostedAdminClientAvailable = () => false;

  const result = await sut.ensureStarterSubscriptionForAppUser({
    clientId: app.clientId,
    externalUserId: "external-1",
  });
  assert.deepEqual(result, {
    openmeterSubscriptionId: null,
    planId: starter.id,
    created: false,
  });
});

dbTest("ensureStarterSubscriptionForAppUser delegates owners to the Owner Starter plan", async (t) => {
  const { app, starter } = await seedApp();
  t.after(() => cleanupTestApp(app));
  billingIdentity.resolveOpenMeterBillingIdentity = async () => ({
    customerKey: app.userId,
    isOwner: true,
    ownerUserId: app.userId,
    publicClientId: app.clientId,
    developerAppId: app.clientId,
  });
  customers.listOwnedPublicClientIds = async () => [app.clientId, "app_other"];
  const seen: Array<string[]> = [];
  ownerStarterPlan.ensureOwnerStarterSubscription = async (input: {
    publicClientIds: string[];
  }) => {
    seen.push(input.publicClientIds);
    return {
      openmeterSubscriptionId: "sub_owner",
      planKey: "pymthouse_owner_starter",
      openmeterPlanId: "plan_owner_starter",
      created: false,
    };
  };

  const result = await sut.ensureStarterSubscriptionForAppUser({
    clientId: app.clientId,
    externalUserId: `owner:${app.userId}`,
  });
  assert.deepEqual(result, {
    openmeterSubscriptionId: "sub_owner",
    planId: starter.id,
    created: false,
  });
  assert.deepEqual(seen, [[app.clientId, "app_other"]]);
});

dbTest("ensureStarterSubscriptionForAppUser rejects an unsynced Starter plan", async (t) => {
  const { app, starter } = await seedApp();
  t.after(() => cleanupTestApp(app));
  await db
    .update(plans)
    .set({ openmeterPlanId: null })
    .where(eq(plans.id, starter.id));
  plansSync.syncPlanToOpenMeter = async () => ({ ok: true });

  await assert.rejects(
    () =>
      sut.ensureStarterSubscriptionForAppUser({
        clientId: app.clientId,
        externalUserId: "external-1",
      }),
    /Starter plan is not synced to OpenMeter/,
  );
});

dbTest("ensureStarterSubscriptionForAppUser reuses an existing subscription", async (t) => {
  const { app, starter } = await seedApp();
  t.after(() => cleanupTestApp(app));
  subscriptionRead.findOpenMeterSubscriptionByPlanKey = async () => ({
    id: "sub_existing",
    status: "active",
    customerId: CUSTOMER_ID,
  });

  const result = await sut.ensureStarterSubscriptionForAppUser({
    clientId: app.clientId,
    externalUserId: "external-1",
  });
  assert.deepEqual(result, {
    openmeterSubscriptionId: "sub_existing",
    planId: starter.id,
    created: false,
  });
  assert.deepEqual(created, []);
});

dbTest("ensureStarterSubscriptionForAppUser trusts a verified hint", async (t) => {
  const { app } = await seedApp();
  t.after(() => cleanupTestApp(app));
  subscriptionRead.verifyOpenMeterSubscriptionId = async () => ({
    id: "sub_hint",
    status: "active",
    customerId: CUSTOMER_ID,
  });
  subscriptionRead.findOpenMeterSubscriptionByPlanKey = async () => {
    throw new Error("should not query by plan key when the hint verifies");
  };

  const result = await sut.ensureStarterSubscriptionForAppUser({
    clientId: app.clientId,
    externalUserId: "external-1",
    hintOpenMeterSubscriptionId: "sub_hint",
  });
  assert.equal(result.openmeterSubscriptionId, "sub_hint");
});

dbTest("ensureStarterSubscriptionForAppUser ignores a hint for another customer", async (t) => {
  const { app } = await seedApp();
  t.after(() => cleanupTestApp(app));
  subscriptionRead.verifyOpenMeterSubscriptionId = async () => ({
    id: "sub_hint",
    status: "active",
    customerId: "cust_someone_else",
  });
  subscriptionRead.findOpenMeterSubscriptionByPlanKey = async () => ({
    id: "sub_by_key",
    status: "active",
    customerId: CUSTOMER_ID,
  });

  const result = await sut.ensureStarterSubscriptionForAppUser({
    clientId: app.clientId,
    externalUserId: "external-1",
    hintOpenMeterSubscriptionId: "sub_hint",
  });
  assert.equal(result.openmeterSubscriptionId, "sub_by_key");
});

dbTest("ensureStarterSubscriptionForAppUser creates a subscription by plan id", async (t) => {
  const { app, starter } = await seedApp();
  t.after(() => cleanupTestApp(app));

  const result = await sut.ensureStarterSubscriptionForAppUser({
    clientId: app.clientId,
    externalUserId: "external-1",
  });
  assert.deepEqual(result, {
    openmeterSubscriptionId: "sub_created",
    planId: starter.id,
    created: true,
  });
  assert.deepEqual(created, [
    { customerId: CUSTOMER_ID, plan: { id: starter.openmeterPlanId } },
  ]);
  assert.deepEqual(freeProfileApplied, []);
});

dbTest("ensureStarterSubscriptionForAppUser rejects a create with no id", async (t) => {
  const { app } = await seedApp();
  t.after(() => cleanupTestApp(app));
  subscriptionsCreate = async () => null;

  await assert.rejects(
    () =>
      sut.ensureStarterSubscriptionForAppUser({
        clientId: app.clientId,
        externalUserId: "external-1",
      }),
    /Failed to create OpenMeter Starter subscription/,
  );
});

dbTest("ensureStarterSubscriptionForAppUser adopts the winner of a create conflict", async (t) => {
  const { app } = await seedApp();
  t.after(() => cleanupTestApp(app));
  let queried = 0;
  subscriptionRead.findOpenMeterSubscriptionByPlanKey = async () => {
    queried += 1;
    return queried === 1
      ? null
      : { id: "sub_raced", status: "active", customerId: CUSTOMER_ID };
  };
  subscriptionsCreate = async () => {
    throw conflictError();
  };

  const result = await sut.ensureStarterSubscriptionForAppUser({
    clientId: app.clientId,
    externalUserId: "external-1",
  });
  assert.equal(result.openmeterSubscriptionId, "sub_raced");
  assert.equal(result.created, false);
});

dbTest("ensureStarterSubscriptionForAppUser rethrows a conflict with no winner", async (t) => {
  const { app } = await seedApp();
  t.after(() => cleanupTestApp(app));
  subscriptionsCreate = async () => {
    throw conflictError();
  };

  await assert.rejects(
    () =>
      sut.ensureStarterSubscriptionForAppUser({
        clientId: app.clientId,
        externalUserId: "external-1",
      }),
    /already exists/,
  );
  assert.deepEqual(freeProfileApplied, []);
});

dbTest("ensureStarterSubscriptionForAppUser retries a Stripe setup error on the free profile", async (t) => {
  const { app } = await seedApp();
  t.after(() => cleanupTestApp(app));
  let attempt = 0;
  subscriptionsCreate = async () => {
    attempt += 1;
    if (attempt === 1) {
      throw stripeBillingError();
    }
    return { id: "sub_after_profile", status: "active", customerId: CUSTOMER_ID };
  };

  const result = await sut.ensureStarterSubscriptionForAppUser({
    clientId: app.clientId,
    externalUserId: "external-1",
  });
  assert.equal(result.openmeterSubscriptionId, "sub_after_profile");
  assert.deepEqual(freeProfileApplied, [CUSTOMER_ID]);
});

dbTest("ensureStarterSubscriptionForAppUser adopts a conflict raised by the retry", async (t) => {
  const { app } = await seedApp();
  t.after(() => cleanupTestApp(app));
  let queried = 0;
  subscriptionRead.findOpenMeterSubscriptionByPlanKey = async () => {
    queried += 1;
    return queried === 1
      ? null
      : { id: "sub_raced_retry", status: "active", customerId: CUSTOMER_ID };
  };
  let attempt = 0;
  subscriptionsCreate = async () => {
    attempt += 1;
    throw attempt === 1 ? stripeBillingError() : conflictError();
  };

  const result = await sut.ensureStarterSubscriptionForAppUser({
    clientId: app.clientId,
    externalUserId: "external-1",
  });
  assert.equal(result.openmeterSubscriptionId, "sub_raced_retry");
  assert.equal(result.created, false);
});

dbTest("ensureStarterSubscriptionForAppUser rethrows a failing retry", async (t) => {
  const { app } = await seedApp();
  t.after(() => cleanupTestApp(app));
  let attempt = 0;
  subscriptionsCreate = async () => {
    attempt += 1;
    throw attempt === 1
      ? stripeBillingError()
      : new Error("retry create exploded");
  };

  await assert.rejects(
    () =>
      sut.ensureStarterSubscriptionForAppUser({
        clientId: app.clientId,
        externalUserId: "external-1",
      }),
    /retry create exploded/,
  );
});

dbTest("ensureStarterSubscriptionForAppUser re-syncs the plan on a plan-not-found create", async (t) => {
  const { app, starter } = await seedApp();
  t.after(() => cleanupTestApp(app));
  plansSync.syncPlanToOpenMeter = async () => {
    await db
      .update(plans)
      .set({ openmeterPlanId: "plan_resynced" })
      .where(eq(plans.id, starter.id));
    return { ok: true };
  };
  let attempt = 0;
  subscriptionsCreate = async () => {
    attempt += 1;
    if (attempt === 1) {
      throw planNotFoundError();
    }
    return { id: "sub_after_resync", status: "active", customerId: CUSTOMER_ID };
  };

  const result = await sut.ensureStarterSubscriptionForAppUser({
    clientId: app.clientId,
    externalUserId: "external-1",
  });
  assert.deepEqual(result, {
    openmeterSubscriptionId: "sub_after_resync",
    planId: starter.id,
    created: true,
  });
  assert.deepEqual(created[1]?.plan, { id: "plan_resynced" });
});

dbTest("ensureStarterSubscriptionForAppUser surfaces a failed recovery sync", async (t) => {
  const { app } = await seedApp();
  t.after(() => cleanupTestApp(app));
  plansSync.syncPlanToOpenMeter = async () => ({
    ok: false,
    error: "resync rejected",
  });
  subscriptionsCreate = async () => {
    throw planNotFoundError();
  };

  await assert.rejects(
    () =>
      sut.ensureStarterSubscriptionForAppUser({
        clientId: app.clientId,
        externalUserId: "external-1",
      }),
    /resync rejected/,
  );
});

dbTest("ensureStarterSubscriptionForAppUser rethrows an unrelated create error", async (t) => {
  const { app } = await seedApp();
  t.after(() => cleanupTestApp(app));
  subscriptionsCreate = async () => {
    throw new Error("openmeter exploded");
  };

  await assert.rejects(
    () =>
      sut.ensureStarterSubscriptionForAppUser({
        clientId: app.clientId,
        externalUserId: "external-1",
      }),
    /openmeter exploded/,
  );
});

dbTest("ensureStarterSubscriptionForAppUser falls back to the plan key after a blank re-sync", async (t) => {
  const { app, starter } = await seedApp();
  t.after(() => cleanupTestApp(app));
  // A re-sync that reports ok but leaves openmeterPlanId unset is the only way
  // the create can reach the { key } plan reference.
  plansSync.syncPlanToOpenMeter = async () => {
    await db
      .update(plans)
      .set({ openmeterPlanId: null })
      .where(eq(plans.id, starter.id));
    return { ok: true };
  };
  let attempt = 0;
  subscriptionsCreate = async () => {
    attempt += 1;
    if (attempt === 1) {
      throw planNotFoundError();
    }
    return { id: "sub_by_key", status: "active", customerId: CUSTOMER_ID };
  };

  const result = await sut.ensureStarterSubscriptionForAppUser({
    clientId: app.clientId,
    externalUserId: "external-1",
  });
  assert.equal(result.openmeterSubscriptionId, "sub_by_key");
  assert.deepEqual(created[1]?.plan, {
    key: buildOpenMeterPlanKey(app.clientId, starter.id),
  });
});
