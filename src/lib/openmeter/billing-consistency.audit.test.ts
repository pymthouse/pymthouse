import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { before, beforeEach } from "node:test";
import { eq } from "drizzle-orm";

import { db } from "@/db/index";
import { plans } from "@/db/schema";
import { buildOpenMeterPlanKey } from "@/lib/openmeter/plan-naming";
import { includedDiscountUsdMicrosForPlan } from "@/lib/openmeter/spendable-allowance";
import { test as dbTest } from "@/test-utils/db-guard";
import {
  cleanupTestApp,
  seedDeveloperAppWithClient,
  type SeededDeveloperApp,
} from "@/test-utils/fixtures";
import { createStubRegistry } from "@/test-utils/module-stubs";

type MeterRow = { subject?: string; value: number | string };

type FakeSubscription = {
  id: string;
  status: string;
  planId?: string | null;
  planKey?: string | null;
};

type FakePlan = {
  id: string;
  key?: string | null;
  version?: number;
  usageDiscountUsdMicros?: string | null;
};

const remotePlans = new Map<string, FakePlan>();
/** Total usage per meter subject; drives the attribution drill-down. */
const usageBySubject = new Map<string, bigint>();
let planGetFails = false;
let meterQueryFails = false;

const fakeClient = {
  plans: {
    get: async (planId: string) => {
      if (planGetFails) {
        throw new Error("konnect plans.get failed");
      }
      const found = remotePlans.get(planId);
      if (!found) {
        return null;
      }
      return {
        id: found.id,
        key: found.key ?? null,
        version: found.version,
        phases: [
          {
            rateCards: [
              ...(found.usageDiscountUsdMicros == null
                ? []
                : [{ discounts: { usage: found.usageDiscountUsdMicros } }]),
            ],
          },
        ],
      };
    },
  },
  meters: {
    query: async (
      _meter: string,
      options: { subject?: string[] },
    ): Promise<{ data: MeterRow[] }> => {
      if (meterQueryFails) {
        throw new Error("konnect meters.query failed");
      }
      const data: MeterRow[] = [];
      for (const subject of options.subject ?? []) {
        const value = usageBySubject.get(subject);
        if (value != null && value > 0n) {
          data.push({ subject, value: value.toString() });
        }
      }
      return { data };
    },
  },
};

const stubs = createStubRegistry();

const adminClient = stubs.module("@/lib/openmeter/admin-client", {
  isHostedAdminClientAvailable: (): boolean => true,
  getHostedAdminClient: (): unknown => fakeClient,
});

const paymentMethod = stubs.module("@/lib/openmeter/owner-payment-method", {
  ownerHasChargeablePaymentMethod: async (): Promise<boolean | null> => false,
});

const customers = stubs.module("@/lib/openmeter/customers", {
  findOpenMeterCustomerByKey: async (
    _client: unknown,
    key: string,
  ): Promise<unknown> => ({
    id: `cust_${key}`,
    usageAttribution: { subjectKeys: [key] },
  }),
  listOwnedPublicClientIds: async (): Promise<string[]> => [],
});

const entitlements = stubs.module("@/lib/openmeter/entitlements", {
  getTrialCreditBalance: async (): Promise<{ balanceUsdMicros: string } | null> =>
    null,
});

const spendable = stubs.module("@/lib/openmeter/spendable-allowance", {
  includedDiscountUsdMicrosForPlan,
  getRemainingPlanDiscountUsdMicros: async (): Promise<bigint> => 0n,
  getSpendableUsdMicros: async (): Promise<string> => "0",
});

const subscriptionRead = stubs.module("@/lib/openmeter/subscription-read", {
  isOpenMeterSubscriptionActive: (status: string): boolean =>
    status === "active" || status === "trialing",
  listOpenMeterSubscriptionsForCustomer: async (): Promise<FakeSubscription[]> => [],
});

const stripeCustomerData = stubs.module("@/lib/openmeter/stripe-customer-data", {
  getStripeCustomerAppDataId: async (): Promise<string | null> => "cus_test",
  getKonnectCustomerBillingProfileId: async (): Promise<string | null> => null,
});

const konnectSubscriptions = stubs.module(
  "@/lib/openmeter/konnect-subscriptions",
  {
    countActiveKonnectSubscriptionsForPlan: async (): Promise<number> => 0,
  },
);

const allowancePlan = stubs.module("@/lib/openmeter/owner-allowance-plan", {
  findOpenMeterPlanByKey: async (): Promise<{ id: string } | null> => null,
  readUsageDiscountUsdMicrosFromPlanBody: (plan: unknown): string | null => {
    const phases = (plan as { phases?: Array<{ rateCards?: Array<{ discounts?: { usage?: unknown } }> }> })
      .phases;
    const usage = phases?.[0]?.rateCards?.[0]?.discounts?.usage;
    return usage == null ? null : String(usage);
  },
});

const platformDefault = stubs.module(
  "@/lib/billing/platform-owner-starter-default",
  {
    resolvePlatformOwnerStarterIncludedUsdMicros: async (): Promise<string> =>
      "5000000",
  },
);

const STARTER_MICROS = "5000000";

let sut: typeof import("@/lib/openmeter/billing-consistency");

before(async () => {
  sut = await import("@/lib/openmeter/billing-consistency");
});

beforeEach(() => {
  stubs.reset();
  remotePlans.clear();
  usageBySubject.clear();
  planGetFails = false;
  meterQueryFails = false;
  process.env.OPENMETER_ROUTE_MODE = "self_hosted";
  delete process.env.OPENMETER_FREE_BILLING_PROFILE_ID;
});

async function seedOwnerWithStarter(): Promise<{
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
    .set({ includedUsdMicros: STARTER_MICROS, openmeterPlanId: `plan_${starter.id}` })
    .where(eq(plans.id, starter.id));
  const refreshed = await db.select().from(plans).where(eq(plans.id, starter.id));
  return { app, starter: refreshed[0]! };
}

function codes(findings: Array<{ code: string }>): string[] {
  return findings.map((f) => f.code);
}

/** Audit scoped to one seeded owner + app so parallel test files cannot bleed in. */
function auditOwnerApp(app: SeededDeveloperApp) {
  return sut.auditBillingConsistency({
    ownerId: app.userId,
    clientId: app.clientId,
  });
}

async function seedPhaseOutPlan(
  app: SeededDeveloperApp,
  overrides: Partial<typeof plans.$inferInsert> = {},
): Promise<void> {
  await db.insert(plans).values({
    id: `plan-phaseout-${randomUUID()}`,
    clientId: app.clientId,
    name: `Legacy ${randomUUID().slice(0, 8)}`,
    status: "phase_out",
    phaseOutAt: "2020-01-01T00:00:00.000Z",
    openmeterPlanId: "plan_legacy_pro",
    ...overrides,
  });
}

dbTest("auditBillingConsistency reports an unconfigured OpenMeter", async () => {
  adminClient.isHostedAdminClientAvailable = () => false;
  const findings = await sut.auditBillingConsistency({ ownerId: "user-anything" });
  assert.deepEqual(codes(findings), ["openmeter_unconfigured"]);
});

dbTest("auditBillingConsistency reports an unknown clientId filter", async () => {
  const findings = await sut.auditBillingConsistency({
    clientId: `app_missing_${randomUUID().slice(0, 8)}`,
  });
  assert.deepEqual(codes(findings), ["client_not_found"]);
});

dbTest("auditBillingConsistency warns when an owner has no Starter plans", async (t) => {
  const app = await seedDeveloperAppWithClient();
  t.after(() => cleanupTestApp(app));
  await db
    .update(plans)
    .set({ status: "draft" })
    .where(eq(plans.clientId, app.clientId));

  const findings = await sut.auditBillingConsistency({ ownerId: app.userId });
  assert.ok(codes(findings).includes("owner_no_starter_plans"));
});

dbTest("auditBillingConsistency is quiet for a healthy owner wallet", async (t) => {
  const { app, starter } = await seedOwnerWithStarter();
  t.after(() => cleanupTestApp(app));

  remotePlans.set(starter.openmeterPlanId!, {
    id: starter.openmeterPlanId!,
    key: buildOpenMeterPlanKey(app.clientId, starter.id),
    usageDiscountUsdMicros: STARTER_MICROS,
  });
  remotePlans.set("plan_owner_starter", {
    id: "plan_owner_starter",
    key: "pymthouse_owner_starter",
    usageDiscountUsdMicros: STARTER_MICROS,
  });
  subscriptionRead.listOpenMeterSubscriptionsForCustomer = async () => [
    {
      id: "sub_owner",
      status: "active",
      planId: "plan_owner_starter",
      planKey: "pymthouse_owner_starter",
    },
  ];
  spendable.getRemainingPlanDiscountUsdMicros = async () => 5_000_000n;
  spendable.getSpendableUsdMicros = async () => "5000000";
  allowancePlan.findOpenMeterPlanByKey = async () => ({ id: "plan_owner_paid" });
  remotePlans.set("plan_owner_paid", {
    id: "plan_owner_paid",
    key: "pymthouse_owner_paid",
    usageDiscountUsdMicros: STARTER_MICROS,
  });

  const findings = await auditOwnerApp(app);
  assert.deepEqual(codes(findings), []);
});

dbTest("auditBillingConsistency flags a Starter plan missing from Konnect", async (t) => {
  const { app, starter } = await seedOwnerWithStarter();
  t.after(() => cleanupTestApp(app));
  planGetFails = true;
  subscriptionRead.listOpenMeterSubscriptionsForCustomer = async () => [
    { id: "sub_owner", status: "active", planId: null, planKey: null },
  ];

  const findings = await auditOwnerApp(app);
  assert.ok(codes(findings).includes("starter_openmeter_plan_missing"));
  assert.ok(codes(findings).includes("owner_subscription_missing_plan_id"));
  assert.ok(starter.openmeterPlanId);
});

dbTest("auditBillingConsistency flags an unsynced Starter row", async (t) => {
  const { app, starter } = await seedOwnerWithStarter();
  t.after(() => cleanupTestApp(app));
  await db
    .update(plans)
    .set({ openmeterPlanId: null })
    .where(eq(plans.id, starter.id));

  const findings = await auditOwnerApp(app);
  assert.ok(codes(findings).includes("starter_openmeter_plan_id_missing"));
});

dbTest("auditBillingConsistency skips Starters outside the clientId filter", async (t) => {
  const { app, starter } = await seedOwnerWithStarter();
  t.after(() => cleanupTestApp(app));
  await db
    .update(plans)
    .set({ openmeterPlanId: null })
    .where(eq(plans.id, starter.id));

  const findings = await sut.auditBillingConsistency({
    ownerId: app.userId,
    clientId: "app_some_other_app",
  });
  assert.ok(!codes(findings).includes("starter_openmeter_plan_id_missing"));
});

dbTest("auditBillingConsistency reports a missing owner customer", async (t) => {
  const { app } = await seedOwnerWithStarter();
  t.after(() => cleanupTestApp(app));
  customers.findOpenMeterCustomerByKey = async () => null;

  const findings = await auditOwnerApp(app);
  assert.ok(codes(findings).includes("owner_customer_missing"));
});

dbTest("auditBillingConsistency reports a failed owner customer lookup", async (t) => {
  const { app } = await seedOwnerWithStarter();
  t.after(() => cleanupTestApp(app));
  customers.findOpenMeterCustomerByKey = async () => {
    throw new Error("konnect customers list failed");
  };

  const findings = await auditOwnerApp(app);
  const lookup = findings.find((f) => f.code === "owner_customer_lookup_failed");
  assert.equal(lookup?.message, "konnect customers list failed");
});

dbTest("auditBillingConsistency flags a chargeable owner without Stripe app data", async (t) => {
  const { app } = await seedOwnerWithStarter();
  t.after(() => cleanupTestApp(app));
  stripeCustomerData.getStripeCustomerAppDataId = async () => null;
  paymentMethod.ownerHasChargeablePaymentMethod = async () => true;

  const findings = await auditOwnerApp(app);
  assert.ok(codes(findings).includes("owner_missing_stripe_app_data"));
});

dbTest("auditBillingConsistency ignores missing Stripe app data without a card", async (t) => {
  const { app } = await seedOwnerWithStarter();
  t.after(() => cleanupTestApp(app));
  stripeCustomerData.getStripeCustomerAppDataId = async () => null;
  paymentMethod.ownerHasChargeablePaymentMethod = async () => null;

  const findings = await auditOwnerApp(app);
  assert.ok(!codes(findings).includes("owner_missing_stripe_app_data"));
});

dbTest("auditBillingConsistency warns about a sandbox profile with a card", async (t) => {
  const { app } = await seedOwnerWithStarter();
  t.after(() => cleanupTestApp(app));
  process.env.OPENMETER_ROUTE_MODE = "hosted";
  process.env.OPENMETER_FREE_BILLING_PROFILE_ID = "bp_sandbox";
  stripeCustomerData.getKonnectCustomerBillingProfileId = async () => "bp_sandbox";
  paymentMethod.ownerHasChargeablePaymentMethod = async () => true;

  const findings = await auditOwnerApp(app);
  assert.ok(codes(findings).includes("owner_sandbox_billing_profile"));
});

dbTest("auditBillingConsistency ignores a non-sandbox billing profile", async (t) => {
  const { app } = await seedOwnerWithStarter();
  t.after(() => cleanupTestApp(app));
  process.env.OPENMETER_ROUTE_MODE = "hosted";
  process.env.OPENMETER_FREE_BILLING_PROFILE_ID = "bp_sandbox";
  stripeCustomerData.getKonnectCustomerBillingProfileId = async () => "bp_stripe";
  paymentMethod.ownerHasChargeablePaymentMethod = async () => true;

  const findings = await auditOwnerApp(app);
  assert.ok(!codes(findings).includes("owner_sandbox_billing_profile"));
});

dbTest("auditBillingConsistency reports no active owner subscription", async (t) => {
  const { app } = await seedOwnerWithStarter();
  t.after(() => cleanupTestApp(app));
  subscriptionRead.listOpenMeterSubscriptionsForCustomer = async () => [
    { id: "sub_cancelled", status: "canceled" },
  ];

  const findings = await auditOwnerApp(app);
  assert.ok(codes(findings).includes("owner_no_active_subscription"));
});

dbTest("auditBillingConsistency warns on duplicate active owner subscriptions", async (t) => {
  const { app } = await seedOwnerWithStarter();
  t.after(() => cleanupTestApp(app));
  remotePlans.set("plan_owner_starter", {
    id: "plan_owner_starter",
    key: "pymthouse_owner_starter",
    usageDiscountUsdMicros: STARTER_MICROS,
  });
  subscriptionRead.listOpenMeterSubscriptionsForCustomer = async () => [
    { id: "sub_a", status: "active", planId: "plan_owner_starter", planKey: null },
    { id: "sub_b", status: "trialing", planId: "plan_owner_starter", planKey: null },
  ];

  const findings = await auditOwnerApp(app);
  const duplicate = findings.find(
    (f) => f.code === "owner_multiple_active_subscriptions",
  );
  assert.deepEqual(duplicate?.details?.subscriptionIds, ["sub_a", "sub_b"]);
});

dbTest("auditBillingConsistency names subjects carrying unattributed usage", async (t) => {
  const { app } = await seedOwnerWithStarter();
  t.after(() => cleanupTestApp(app));
  customers.listOwnedPublicClientIds = async () => [app.clientId];
  usageBySubject.set(`owner:${app.userId}`, 250_000n);

  const findings = await auditOwnerApp(app);
  const leak = findings.find((f) => f.code === "usage_on_unattributed_subject");
  assert.deepEqual(leak?.details?.unattributed, [`owner:${app.userId}`]);
});

dbTest("auditBillingConsistency treats an unreadable meter as no usage", async (t) => {
  const { app } = await seedOwnerWithStarter();
  t.after(() => cleanupTestApp(app));
  meterQueryFails = true;

  const findings = await auditOwnerApp(app);
  assert.ok(!codes(findings).includes("usage_on_unattributed_subject"));
});

dbTest("auditBillingConsistency flags a blocking spendable gate", async (t) => {
  const { app } = await seedOwnerWithStarter();
  t.after(() => cleanupTestApp(app));
  usageBySubject.set(app.userId, 138_382n);
  customers.findOpenMeterCustomerByKey = async (_client: unknown, key: string) => ({
    id: `cust_${key}`,
    usageAttribution: { subjectKeys: [key, `owner:${key}`] },
  });

  const findings = await auditOwnerApp(app);
  const gate = findings.find(
    (f) => f.code === "spendable_gate_blocks_with_unused_allowance",
  );
  assert.equal(gate?.details?.usedUsdMicros, "138382");
});

dbTest("auditBillingConsistency reads credit balances into the gate check", async (t) => {
  const { app } = await seedOwnerWithStarter();
  t.after(() => cleanupTestApp(app));
  entitlements.getTrialCreditBalance = async () => ({
    balanceUsdMicros: "2000000",
  });
  spendable.getRemainingPlanDiscountUsdMicros = async () => 3_000_000n;
  spendable.getSpendableUsdMicros = async () => "5000000";

  const findings = await auditOwnerApp(app);
  assert.ok(!codes(findings).includes("spendable_sum_mismatch"));
  assert.ok(!codes(findings).includes("spendable_gate_blocks_with_unused_allowance"));
});

dbTest("auditBillingConsistency reports phase-out plans past their deadline", async (t) => {
  const { app } = await seedOwnerWithStarter();
  t.after(() => cleanupTestApp(app));
  await seedPhaseOutPlan(app);
  konnectSubscriptions.countActiveKonnectSubscriptionsForPlan = async () => 4;

  const findings = await sut.auditBillingConsistency({ clientId: app.clientId });
  const phaseOut = findings.find(
    (f) => f.code === "phase_out_subscribers_past_deadline",
  );
  assert.equal(phaseOut?.details?.activeSubscriberCount, 4);
});

dbTest("auditBillingConsistency warns when the subscriber count is unreadable", async (t) => {
  const { app } = await seedOwnerWithStarter();
  t.after(() => cleanupTestApp(app));
  await seedPhaseOutPlan(app);
  konnectSubscriptions.countActiveKonnectSubscriptionsForPlan = async () => {
    throw new Error("konnect subscriptions list failed");
  };

  const findings = await sut.auditBillingConsistency({ clientId: app.clientId });
  const failed = findings.find(
    (f) => f.code === "phase_out_subscriber_check_failed",
  );
  assert.equal(failed?.details?.error, "konnect subscriptions list failed");
});

dbTest("auditBillingConsistency ignores phase-out plans before the deadline", async (t) => {
  const { app } = await seedOwnerWithStarter();
  t.after(() => cleanupTestApp(app));
  await seedPhaseOutPlan(app, { phaseOutAt: "2099-01-01T00:00:00.000Z" });
  await seedPhaseOutPlan(app, { openmeterPlanId: null });

  const findings = await sut.auditBillingConsistency({ clientId: app.clientId });
  assert.ok(!codes(findings).includes("phase_out_subscribers_past_deadline"));
  assert.ok(!codes(findings).includes("phase_out_subscriber_check_failed"));
});

dbTest("auditBillingConsistency warns when the Owner Paid plan is unpublished", async (t) => {
  const { app } = await seedOwnerWithStarter();
  t.after(() => cleanupTestApp(app));
  allowancePlan.findOpenMeterPlanByKey = async () => {
    throw new Error("konnect plans list failed");
  };

  const findings = await auditOwnerApp(app);
  assert.ok(codes(findings).includes("owner_paid_plan_missing"));
});

dbTest("auditBillingConsistency flags Owner Paid allowance drift", async (t) => {
  const { app } = await seedOwnerWithStarter();
  t.after(() => cleanupTestApp(app));
  platformDefault.resolvePlatformOwnerStarterIncludedUsdMicros = async () =>
    "9000000";
  allowancePlan.findOpenMeterPlanByKey = async () => ({ id: "plan_owner_paid" });
  remotePlans.set("plan_owner_paid", {
    id: "plan_owner_paid",
    key: "pymthouse_owner_paid",
    usageDiscountUsdMicros: STARTER_MICROS,
  });

  const findings = await auditOwnerApp(app);
  assert.ok(codes(findings).includes("owner_paid_plan_allowance_drift"));
});

dbTest("auditBillingConsistency scans a bounded set of owners with no filter", async (t) => {
  const { app } = await seedOwnerWithStarter();
  t.after(() => cleanupTestApp(app));

  const findings = await sut.auditBillingConsistency({ limit: 1 });
  assert.ok(Array.isArray(findings));
});
