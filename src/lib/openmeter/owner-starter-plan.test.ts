import assert from "node:assert/strict";
import test, { before, beforeEach } from "node:test";

import { createStubRegistry } from "@/test-utils/module-stubs";

type FakeSubscription = {
  id: string;
  status?: string;
  planKey?: string | null;
  planId?: string | null;
  customerId?: string | null;
};

const OWNER_ID = "user_owner_1";
const CUSTOMER_ID = "cust_owner_1";
const PLAN_ID = "01OWNERSTARTERPLAN0000000001";
const STARTER_KEY = "pymthouse_owner_starter";
const PAID_KEY = "pymthouse_owner_paid";

const cancelled: string[] = [];
const changed: Array<{ subscriptionId: string; planId: string }> = [];
const freeProfileApplied: string[] = [];
const created: Array<{ customerId: string; planKey: string | undefined }> = [];

let subscriptionsCreate: () => Promise<{ id?: string } | null> = async () => ({
  id: "sub_new",
});
let subscriptionsCancel: () => Promise<void> = async () => undefined;

const fakeClient = {
  subscriptions: {
    create: async (body: { customerId: string; plan?: { key?: string } }) => {
      created.push({ customerId: body.customerId, planKey: body.plan?.key });
      return subscriptionsCreate();
    },
    cancel: async (id: string) => {
      cancelled.push(id);
      return subscriptionsCancel();
    },
  },
};

const stubs = createStubRegistry();

const adminClient = stubs.module("@/lib/openmeter/admin-client", {
  isHostedAdminClientAvailable: (): boolean => true,
  getHostedAdminClient: (): unknown => fakeClient,
});

const platformDefault = stubs.module(
  "@/lib/billing/platform-owner-starter-default",
  {
    resolvePlatformOwnerStarterIncludedUsdMicros: async (): Promise<string> =>
      "5000000",
    resolvePlatformOwnerStarterPlanName: async (): Promise<string> =>
      "Owner Sandbox Starter",
    resolvePlatformOwnerStarterDefault: async (): Promise<{
      ownerStarterIncludedUsdMicros: string;
      ownerStarterPlanName: string;
    }> => ({
      ownerStarterIncludedUsdMicros: "5000000",
      ownerStarterPlanName: "Owner Sandbox Starter",
    }),
  },
);

const ownerBillingConfig = stubs.module("@/lib/billing/owner-billing-config", {
  resolveOwnerStarterIncludedUsdMicros: async (): Promise<string> => "5000000",
});

stubs.module("@/lib/openmeter/billing-profiles", {
  applyFreeBillingProfileToCustomer: async (input: {
    customerId: string;
  }): Promise<void> => {
    freeProfileApplied.push(input.customerId);
  },
});

const catalog = stubs.module("@/lib/openmeter/konnect-catalog", {
  ensureKonnectTenantCatalog: async (): Promise<void> => undefined,
  findKonnectFeatureIdByKey: async (): Promise<string | null> => "feature_1",
});

const konnectSubscriptions = stubs.module(
  "@/lib/openmeter/konnect-subscriptions",
  {
    changeKonnectSubscription: async (input: {
      subscriptionId: string;
      planId: string;
    }): Promise<void> => {
      changed.push({ subscriptionId: input.subscriptionId, planId: input.planId });
    },
  },
);

const allowancePlan = stubs.module("@/lib/openmeter/owner-allowance-plan", {
  findOpenMeterPlanByKey: async (
    _client: unknown,
    _planKey: string,
  ): Promise<{ id: string; status?: string } | null> => null,
  createOwnerAllowancePlan: async (_input: {
    planKey: string;
    includedUsdMicros: string;
  }): Promise<string> => PLAN_ID,
  publishOpenMeterPlanBestEffort: async (
    _client: unknown,
    planId: string,
  ): Promise<string> => planId,
  openMeterPlanNeedsPublish: (status: string | undefined): boolean =>
    status === "draft",
  forceSyncOwnerAllowancePlan: async (input: {
    planKey: string;
    planName: string;
    includedUsdMicros: string;
  }): Promise<{
    key: string;
    openmeterPlanId: string;
    includedUsdMicros: string;
  }> => ({
    key: input.planKey,
    openmeterPlanId: PLAN_ID,
    includedUsdMicros: input.includedUsdMicros,
  }),
});

const customers = stubs.module("@/lib/openmeter/customers", {
  ensureOwnerCustomer: async (
    _client: unknown,
    _ownerUserId: string,
    _publicClientIds: string[],
  ): Promise<{ id: string }> => ({ id: CUSTOMER_ID }),
});

const subscriptionRead = stubs.module("@/lib/openmeter/subscription-read", {
  verifyOpenMeterSubscriptionId: async (): Promise<FakeSubscription | null> => null,
  findOpenMeterSubscriptionByPlanKey:
    async (): Promise<FakeSubscription | null> => null,
  listOpenMeterSubscriptionsForCustomer: async (): Promise<FakeSubscription[]> => [],
});

process.env.OPENMETER_ROUTE_MODE = "hosted";
process.env.OPENMETER_API_KEY ??= "km_test_owner_starter";

// The stubs above must be registered before the module graph loads, so the
// subject is imported dynamically once the mocks are in place.
let sut: typeof import("@/lib/openmeter/owner-starter-plan");

before(async () => {
  sut = await import("@/lib/openmeter/owner-starter-plan");
});

beforeEach(() => {
  stubs.reset();
  cancelled.length = 0;
  changed.length = 0;
  freeProfileApplied.length = 0;
  created.length = 0;
  subscriptionsCreate = async () => ({ id: "sub_new" });
  subscriptionsCancel = async () => undefined;
  process.env.OPENMETER_ROUTE_MODE = "hosted";
  sut.resetOwnerStarterPlanCacheForTests();
  sut.invalidateOwnerStarterPlanCache();
});

const conflictError = () => new Error("conflict error: subscription already exists");
const planNotFoundError = () => new Error("plan not found");
const stripeBillingError = () => new Error("invalid billing setup");

/** The common case: the Owner Starter plan for the resolved amount is published. */
function withPublishedPlan(planId = PLAN_ID): void {
  allowancePlan.findOpenMeterPlanByKey = async () => ({
    id: planId,
    status: "active",
  });
}

/** Owner is on the base Starter plan but their allowance now maps elsewhere. */
function withOffAmountStarter(): void {
  ownerBillingConfig.resolveOwnerStarterIncludedUsdMicros = async () => "9000000";
  withPublishedPlan("plan_amount_keyed");
  subscriptionRead.listOpenMeterSubscriptionsForCustomer = async () => [
    { id: "sub_base", status: "active", planKey: STARTER_KEY, planId: PLAN_ID },
  ];
}

/** Konnect refuses the in-place subscription change. */
function withFailingChange(): void {
  konnectSubscriptions.changeKonnectSubscription = async () => {
    throw new Error("change rejected");
  };
}

/** Drive `subscriptions.create` through one outcome per attempt (last repeats). */
function createSequence(
  ...steps: Array<() => Promise<{ id?: string } | null>>
): void {
  let attempt = 0;
  subscriptionsCreate = async () => {
    const step = steps[Math.min(attempt, steps.length - 1)]!;
    attempt += 1;
    return step();
  };
}

test("ensureOwnerStarterPlanSynced rejects when OpenMeter is unavailable", async () => {
  adminClient.isHostedAdminClientAvailable = () => false;
  await assert.rejects(
    () => sut.ensureOwnerStarterPlanSynced("5000000"),
    /OpenMeter is not configured/,
  );
});

test("ensureOwnerStarterPlanSynced rejects when Konnect routes are off", async () => {
  process.env.OPENMETER_ROUTE_MODE = "self_hosted";
  await assert.rejects(
    () => sut.ensureOwnerStarterPlanSynced("5000000"),
    /requires Konnect metering routes/,
  );
});

test("ensureOwnerStarterPlanSynced rejects when the trial feature is missing", async () => {
  catalog.findKonnectFeatureIdByKey = async () => null;
  await assert.rejects(
    () => sut.ensureOwnerStarterPlanSynced("5000000"),
    /Konnect feature missing/,
  );
});

test("ensureOwnerStarterPlanSynced reuses a published plan without publishing", async () => {
  let published = 0;
  withPublishedPlan();
  allowancePlan.publishOpenMeterPlanBestEffort = async (
    _client: unknown,
    planId: string,
  ) => {
    published += 1;
    return planId;
  };

  const ref = await sut.ensureOwnerStarterPlanSynced("5000000");
  assert.deepEqual(ref, {
    key: STARTER_KEY,
    openmeterPlanId: PLAN_ID,
    includedUsdMicros: "5000000",
  });
  assert.equal(published, 0);
});

test("ensureOwnerStarterPlanSynced publishes an existing draft plan", async () => {
  const published: string[] = [];
  allowancePlan.findOpenMeterPlanByKey = async () => ({
    id: PLAN_ID,
    status: "draft",
  });
  allowancePlan.publishOpenMeterPlanBestEffort = async (
    _client: unknown,
    planId: string,
  ) => {
    published.push(planId);
    return planId;
  };

  const ref = await sut.ensureOwnerStarterPlanSynced("5000000");
  assert.equal(ref.openmeterPlanId, PLAN_ID);
  assert.deepEqual(published, [PLAN_ID]);
});

test("ensureOwnerStarterPlanSynced creates and publishes an amount-keyed plan", async () => {
  const createdPlans: Array<{ planKey: string; includedUsdMicros: string }> = [];
  allowancePlan.createOwnerAllowancePlan = async (input: {
    planKey: string;
    includedUsdMicros: string;
  }) => {
    createdPlans.push(input);
    return "plan_created";
  };
  allowancePlan.publishOpenMeterPlanBestEffort = async () => "plan_published";

  const ref = await sut.ensureOwnerStarterPlanSynced("9000000");
  assert.equal(ref.key, `${STARTER_KEY}_9000000`);
  assert.equal(ref.openmeterPlanId, "plan_published");
  assert.equal(ref.includedUsdMicros, "9000000");
  assert.equal(createdPlans[0]?.planKey, `${STARTER_KEY}_9000000`);
});

test("ensureOwnerStarterPlanSynced falls back to the platform default amount", async () => {
  platformDefault.resolvePlatformOwnerStarterIncludedUsdMicros = async () =>
    "7000000";
  withPublishedPlan();

  const ref = await sut.ensureOwnerStarterPlanSynced();
  assert.equal(ref.key, STARTER_KEY);
  assert.equal(ref.includedUsdMicros, "7000000");
});

test("forceSyncOwnerStarterPlan rejects when OpenMeter is unavailable", async () => {
  allowancePlan.forceSyncOwnerAllowancePlan = async () => {
    throw new Error("OpenMeter is not configured");
  };
  await assert.rejects(
    () => sut.forceSyncOwnerStarterPlan("5000000"),
    /OpenMeter is not configured/,
  );
});

test("forceSyncOwnerStarterPlan rewrites the base key and seeds the cache", async () => {
  const syncs: Array<{ planKey: string; planName: string }> = [];
  allowancePlan.forceSyncOwnerAllowancePlan = async (input: {
    planKey: string;
    planName: string;
    includedUsdMicros: string;
  }) => {
    syncs.push({ planKey: input.planKey, planName: input.planName });
    return {
      key: input.planKey,
      openmeterPlanId: PLAN_ID,
      includedUsdMicros: input.includedUsdMicros,
    };
  };

  const ref = await sut.forceSyncOwnerStarterPlan(" 5000000 ");
  assert.deepEqual(ref, {
    key: STARTER_KEY,
    openmeterPlanId: PLAN_ID,
    includedUsdMicros: "5000000",
  });
  assert.deepEqual(syncs, [
    { planKey: STARTER_KEY, planName: "Owner Sandbox Starter" },
  ]);
});

test("ensureOwnerStarterSubscription returns empty when OpenMeter is unavailable", async () => {
  adminClient.isHostedAdminClientAvailable = () => false;
  const result = await sut.ensureOwnerStarterSubscription({ ownerUserId: OWNER_ID });
  assert.deepEqual(result, {
    openmeterSubscriptionId: null,
    planKey: STARTER_KEY,
    openmeterPlanId: "",
    created: false,
  });
});

test("ensureOwnerStarterSubscription keeps a matching Starter on the free profile", async () => {
  withPublishedPlan();
  subscriptionRead.findOpenMeterSubscriptionByPlanKey = async () => ({
    id: "sub_starter",
    planKey: STARTER_KEY,
    planId: PLAN_ID,
  });

  const result = await sut.ensureOwnerStarterSubscription({ ownerUserId: OWNER_ID });
  assert.deepEqual(result, {
    openmeterSubscriptionId: "sub_starter",
    planKey: STARTER_KEY,
    openmeterPlanId: PLAN_ID,
    created: false,
  });
  assert.deepEqual(freeProfileApplied, [CUSTOMER_ID]);
  assert.deepEqual(created, []);
});

test("ensureOwnerStarterSubscription trusts a verified hint subscription", async () => {
  withPublishedPlan();
  subscriptionRead.verifyOpenMeterSubscriptionId = async () => ({
    id: "sub_hint",
    customerId: CUSTOMER_ID,
    planKey: PAID_KEY,
    planId: "plan_paid",
  });
  subscriptionRead.findOpenMeterSubscriptionByPlanKey = async () => {
    throw new Error("should not query by plan key when the hint verifies");
  };

  const result = await sut.ensureOwnerStarterSubscription({
    ownerUserId: OWNER_ID,
    hintOpenMeterSubscriptionId: "sub_hint",
  });
  assert.deepEqual(result, {
    openmeterSubscriptionId: "sub_hint",
    planKey: PAID_KEY,
    openmeterPlanId: "plan_paid",
    created: false,
  });
  assert.deepEqual(freeProfileApplied, []);
});

test("ensureOwnerStarterSubscription ignores a hint owned by another customer", async () => {
  withPublishedPlan();
  subscriptionRead.verifyOpenMeterSubscriptionId = async () => ({
    id: "sub_other",
    customerId: "cust_someone_else",
    planKey: STARTER_KEY,
    planId: PLAN_ID,
  });
  subscriptionRead.findOpenMeterSubscriptionByPlanKey = async () => ({
    id: "sub_starter",
    planKey: STARTER_KEY,
    planId: PLAN_ID,
  });

  const result = await sut.ensureOwnerStarterSubscription({
    ownerUserId: OWNER_ID,
    hintOpenMeterSubscriptionId: "sub_other",
  });
  assert.equal(result.openmeterSubscriptionId, "sub_starter");
});

test("ensureOwnerStarterSubscription leaves an unknown wallet subscription alone", async () => {
  withPublishedPlan();
  subscriptionRead.listOpenMeterSubscriptionsForCustomer = async () => [
    { id: "sub_expired", status: "expired", planKey: STARTER_KEY, planId: PLAN_ID },
    { id: "sub_unknown", status: "pending", planKey: "some_app_plan", planId: "p9" },
  ];

  const result = await sut.ensureOwnerStarterSubscription({ ownerUserId: OWNER_ID });
  assert.deepEqual(result, {
    openmeterSubscriptionId: "sub_unknown",
    planKey: "some_app_plan",
    openmeterPlanId: "p9",
    created: false,
  });
});

test("ensureOwnerStarterSubscription changes an off-amount Starter in place", async () => {
  withOffAmountStarter();

  const result = await sut.ensureOwnerStarterSubscription({ ownerUserId: OWNER_ID });
  assert.deepEqual(result, {
    openmeterSubscriptionId: "sub_base",
    planKey: `${STARTER_KEY}_9000000`,
    openmeterPlanId: "plan_amount_keyed",
    created: false,
  });
  assert.deepEqual(changed, [
    { subscriptionId: "sub_base", planId: "plan_amount_keyed" },
  ]);
  assert.deepEqual(freeProfileApplied, [CUSTOMER_ID]);
});

test("ensureOwnerStarterSubscription recreates then cancels when the change fails", async () => {
  withOffAmountStarter();
  withFailingChange();
  subscriptionsCreate = async () => ({ id: "sub_recreated" });

  const result = await sut.ensureOwnerStarterSubscription({ ownerUserId: OWNER_ID });
  assert.deepEqual(result, {
    openmeterSubscriptionId: "sub_recreated",
    planKey: `${STARTER_KEY}_9000000`,
    openmeterPlanId: "plan_amount_keyed",
    created: true,
  });
  assert.deepEqual(cancelled, ["sub_base"]);
});

test("ensureOwnerStarterSubscription keeps the recreated subscription when cancel fails", async () => {
  withOffAmountStarter();
  withFailingChange();
  subscriptionsCancel = async () => {
    throw new Error("cancel rejected");
  };

  const result = await sut.ensureOwnerStarterSubscription({ ownerUserId: OWNER_ID });
  assert.equal(result.openmeterSubscriptionId, "sub_new");
  assert.equal(result.created, true);
});

test("ensureOwnerStarterSubscription surfaces the change error when recreate fails", async () => {
  withOffAmountStarter();
  withFailingChange();
  subscriptionsCreate = async () => {
    throw new Error("recreate rejected");
  };

  await assert.rejects(
    () => sut.ensureOwnerStarterSubscription({ ownerUserId: OWNER_ID }),
    /change rejected/,
  );
  assert.deepEqual(cancelled, []);
});

test("ensureOwnerStarterSubscription tolerates a failing subscription list", async () => {
  withPublishedPlan();
  subscriptionRead.listOpenMeterSubscriptionsForCustomer = async () => {
    throw new Error("list unavailable");
  };

  const result = await sut.ensureOwnerStarterSubscription({ ownerUserId: OWNER_ID });
  assert.deepEqual(result, {
    openmeterSubscriptionId: "sub_new",
    planKey: STARTER_KEY,
    openmeterPlanId: PLAN_ID,
    created: true,
  });
  assert.deepEqual(freeProfileApplied, [CUSTOMER_ID]);
});

test("ensureOwnerStarterSubscription skips creation when createIfMissing is false", async () => {
  withPublishedPlan();

  const result = await sut.ensureOwnerStarterSubscription({
    ownerUserId: OWNER_ID,
    createIfMissing: false,
  });
  assert.deepEqual(result, {
    openmeterSubscriptionId: null,
    planKey: STARTER_KEY,
    openmeterPlanId: PLAN_ID,
    created: false,
  });
  assert.deepEqual(created, []);
});

test("ensureOwnerStarterSubscription rejects when create returns no id", async () => {
  withPublishedPlan();
  subscriptionsCreate = async () => null;

  await assert.rejects(
    () => sut.ensureOwnerStarterSubscription({ ownerUserId: OWNER_ID }),
    /Failed to create Owner Starter subscription/,
  );
});

test("ensureOwnerStarterSubscription resyncs the plan on a plan-not-found create", async () => {
  const lookups: string[] = [];
  allowancePlan.findOpenMeterPlanByKey = async (
    _client: unknown,
    planKey: string,
  ) => {
    lookups.push(planKey);
    return { id: PLAN_ID, status: "active" };
  };
  createSequence(
    async () => {
      throw planNotFoundError();
    },
    async () => ({ id: "sub_after_resync" }),
  );

  const result = await sut.ensureOwnerStarterSubscription({ ownerUserId: OWNER_ID });
  assert.deepEqual(result, {
    openmeterSubscriptionId: "sub_after_resync",
    planKey: STARTER_KEY,
    openmeterPlanId: PLAN_ID,
    created: true,
  });
  assert.equal(lookups.length, 2);
});

test("ensureOwnerStarterSubscription adopts the winner of a create race", async () => {
  withPublishedPlan();
  let queried = 0;
  subscriptionRead.findOpenMeterSubscriptionByPlanKey = async () => {
    queried += 1;
    return queried === 1 ? null : { id: "sub_raced", planKey: STARTER_KEY };
  };
  subscriptionsCreate = async () => {
    throw conflictError();
  };

  const result = await sut.ensureOwnerStarterSubscription({ ownerUserId: OWNER_ID });
  assert.deepEqual(result, {
    openmeterSubscriptionId: "sub_raced",
    planKey: STARTER_KEY,
    openmeterPlanId: PLAN_ID,
    created: false,
  });
});

test("ensureOwnerStarterSubscription rethrows a conflict with no winning subscription", async () => {
  withPublishedPlan();
  subscriptionsCreate = async () => {
    throw conflictError();
  };

  await assert.rejects(
    () => sut.ensureOwnerStarterSubscription({ ownerUserId: OWNER_ID }),
    /already exists/,
  );
});

test("ensureOwnerStarterSubscription retries a Stripe billing error on the free profile", async () => {
  withPublishedPlan();
  createSequence(
    async () => {
      throw stripeBillingError();
    },
    async () => ({ id: "sub_after_profile" }),
  );

  const result = await sut.ensureOwnerStarterSubscription({ ownerUserId: OWNER_ID });
  assert.equal(result.openmeterSubscriptionId, "sub_after_profile");
  assert.equal(result.created, true);
  assert.deepEqual(freeProfileApplied, [CUSTOMER_ID, CUSTOMER_ID]);
});

test("ensureOwnerStarterSubscription rejects when the billing retry returns no id", async () => {
  withPublishedPlan();
  createSequence(
    async () => {
      throw stripeBillingError();
    },
    async () => ({}),
  );

  await assert.rejects(
    () => sut.ensureOwnerStarterSubscription({ ownerUserId: OWNER_ID }),
    /after billing profile apply/,
  );
});

test("ensureOwnerStarterSubscription rethrows an unrecognized create error", async () => {
  withPublishedPlan();
  subscriptionsCreate = async () => {
    throw new Error("openmeter exploded");
  };

  await assert.rejects(
    () => sut.ensureOwnerStarterSubscription({ ownerUserId: OWNER_ID }),
    /openmeter exploded/,
  );
});

test("plan-sync recovery rejects when the resynced create returns no id", async () => {
  withPublishedPlan();
  createSequence(
    async () => {
      throw planNotFoundError();
    },
    async () => ({}),
  );

  await assert.rejects(
    () => sut.ensureOwnerStarterSubscription({ ownerUserId: OWNER_ID }),
    /after plan sync$/,
  );
});

test("plan-sync recovery applies the free profile on a Stripe billing error", async () => {
  withPublishedPlan();
  createSequence(
    async () => {
      throw planNotFoundError();
    },
    async () => {
      throw stripeBillingError();
    },
    async () => ({ id: "sub_recovered" }),
  );

  const result = await sut.ensureOwnerStarterSubscription({ ownerUserId: OWNER_ID });
  assert.equal(result.openmeterSubscriptionId, "sub_recovered");
  assert.equal(freeProfileApplied.length, 2);
});

test("plan-sync recovery rejects when the profile retry returns no id", async () => {
  withPublishedPlan();
  createSequence(
    async () => {
      throw planNotFoundError();
    },
    async () => {
      throw stripeBillingError();
    },
    async () => null,
  );

  await assert.rejects(
    () => sut.ensureOwnerStarterSubscription({ ownerUserId: OWNER_ID }),
    /after plan sync and billing profile apply/,
  );
});

test("plan-sync recovery rethrows a non-billing create error", async () => {
  withPublishedPlan();
  createSequence(
    async () => {
      throw planNotFoundError();
    },
    async () => {
      throw new Error("second create exploded");
    },
  );

  await assert.rejects(
    () => sut.ensureOwnerStarterSubscription({ ownerUserId: OWNER_ID }),
    /second create exploded/,
  );
});

test("ensureOwnerStarterSubscription forwards owned client ids to the customer ensure", async () => {
  const seen: Array<string[]> = [];
  withPublishedPlan();
  customers.ensureOwnerCustomer = async (
    _client: unknown,
    _ownerUserId: string,
    publicClientIds: string[],
  ) => {
    seen.push(publicClientIds);
    return { id: CUSTOMER_ID };
  };

  await sut.ensureOwnerStarterSubscription({
    ownerUserId: OWNER_ID,
    publicClientIds: ["app_one", "app_two"],
  });
  assert.deepEqual(seen, [["app_one", "app_two"]]);
});
