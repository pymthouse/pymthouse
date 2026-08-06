import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { before, beforeEach } from "node:test";
import { and, eq } from "drizzle-orm";

import { db } from "@/db/index";
import { plans, subscriptions } from "@/db/schema";
import { buildOpenMeterPlanKey } from "@/lib/openmeter/plan-naming";
import { test as dbTest } from "@/test-utils/db-guard";
import {
  cleanupTestApp,
  seedDeveloperAppWithClient,
  type SeededDeveloperApp,
} from "@/test-utils/fixtures";
import { createStubRegistry } from "@/test-utils/module-stubs";

type BillingConfig = {
  checkoutSuccessUrl?: string | null;
  checkoutCancelUrl?: string | null;
} | null;

const CUSTOMER_ID = "cust_end_user";
const CUSTOMER_KEY = "app:end-user";
const ORIGIN = "https://pymthouse.test";

const openMeterCreates: Array<{ customerId: string; planKey?: string }> = [];
const konnectChanges: Array<{ subscriptionId: string; planId: string; timing: string }> =
  [];

let subscriptionsCreate: () => Promise<{ id?: string } | null> = async () => ({
  id: "om_sub_created",
});

const fakeClient = {
  subscriptions: {
    create: async (body: { customerId: string; plan?: { key?: string } }) => {
      openMeterCreates.push({
        customerId: body.customerId,
        planKey: body.plan?.key,
      });
      return subscriptionsCreate();
    },
  },
};

const stubs = createStubRegistry();

stubs.module("@/lib/openmeter/admin-client", {
  isHostedAdminClientAvailable: (): boolean => true,
  getHostedAdminClient: (): unknown => fakeClient,
});

stubs.module("@/lib/oidc/issuer-urls", {
  getPublicOrigin: (): string => ORIGIN,
});

const billingProfiles = stubs.module("@/lib/openmeter/billing-profiles", {
  getAppBillingConfig: async (): Promise<BillingConfig> => null,
  prepareAppCustomerStripeBilling: async (): Promise<void> => undefined,
  applyTenantBillingProfileToCustomer: async (): Promise<void> => undefined,
});

stubs.module("@/lib/openmeter/customers", {
  ensureOpenMeterCustomerForAppUser: async (): Promise<{
    id: string;
    key: string;
  }> => ({ id: CUSTOMER_ID, key: CUSTOMER_KEY }),
});

const konnectSubscriptions = stubs.module(
  "@/lib/openmeter/konnect-subscriptions",
  {
    changeKonnectSubscription: async (input: {
      subscriptionId: string;
      planId: string;
      timing: string;
    }): Promise<{ next?: { id?: string }; current?: { id?: string } }> => {
      konnectChanges.push(input);
      return { current: { id: input.subscriptionId } };
    },
  },
);

const subscriptionRead = stubs.module("@/lib/openmeter/subscription-read", {
  getPrimaryOpenMeterSubscriptionForAppUser: async (): Promise<{
    id: string;
  } | null> => null,
  resolveLocalPlanIdFromOpenMeterSubscription: async (): Promise<string | null> =>
    null,
});

const checkoutSession = stubs.module("@/lib/openmeter/stripe-checkout-session", {
  createOpenMeterStripeCheckoutSession: async (_input: {
    successUrl: string;
    cancelUrl: string;
  }): Promise<{
    checkoutUrl: string;
    sessionId: string | null;
  }> => ({
    checkoutUrl: "https://checkout.stripe.com/c/pay_openmeter",
    sessionId: "cs_openmeter",
  }),
});

const stripeCustomerData = stubs.module("@/lib/openmeter/stripe-customer-data", {
  getKonnectDefaultPaymentMethodId: async (): Promise<string | null> => null,
});

const merchantConnect = stubs.module("@/lib/stripe/merchant-connect", {
  isMerchantConnectPaymentsReady: (): boolean => false,
  connectPaymentsOnlyEnabled: (): boolean => false,
  createMerchantConnectCheckoutForUser: async (input: {
    successUrl: string;
    cancelUrl: string;
  }): Promise<{ checkoutUrl: string; sessionId: string | null }> => ({
    checkoutUrl: `https://checkout.stripe.com/c/connect?ok=${encodeURIComponent(input.successUrl)}`,
    sessionId: "cs_connect",
  }),
});

let sut: typeof import("@/lib/openmeter/subscriptions-billing");

before(async () => {
  sut = await import("@/lib/openmeter/subscriptions-billing");
});

beforeEach(() => {
  stubs.reset();
  openMeterCreates.length = 0;
  konnectChanges.length = 0;
  subscriptionsCreate = async () => ({ id: "om_sub_created" });
  process.env.OPENMETER_ROUTE_MODE = "hosted";
});

async function seedPaidPlan(
  clientId: string,
  overrides: Partial<typeof plans.$inferInsert> = {},
): Promise<typeof plans.$inferSelect> {
  const id = `plan-paid-${randomUUID()}`;
  await db.insert(plans).values({
    id,
    clientId,
    // plans has a unique (client_id, name) index, so keep every seeded plan
    // distinct even when a test seeds a current and a target plan.
    name: `Plan ${id.slice(-12)}`,
    type: "subscription",
    priceAmount: "19.99",
    status: "active",
    openmeterPlanId: `om_${id}`,
    ...overrides,
  });
  const rows = await db.select().from(plans).where(eq(plans.id, id));
  return rows[0]!;
}

/**
 * Seed an app whose end-user is already on `currentPriceAmount` and wants to
 * move to `targetPriceAmount`, with the current OpenMeter subscription resolved.
 */
async function seedPlanChange(
  t: { after: (fn: () => Promise<void> | void) => void },
  amounts: { currentPriceAmount: string; targetPriceAmount: string },
): Promise<{
  app: SeededDeveloperApp;
  current: typeof plans.$inferSelect;
  target: typeof plans.$inferSelect;
}> {
  const app = await seedDeveloperAppWithClient();
  t.after(() => cleanupTestApp(app));
  const current = await seedPaidPlan(app.clientId, {
    priceAmount: amounts.currentPriceAmount,
    type: amounts.currentPriceAmount === "0" ? "free" : "subscription",
  });
  const target = await seedPaidPlan(app.clientId, {
    priceAmount: amounts.targetPriceAmount,
    type: amounts.targetPriceAmount === "0" ? "free" : "subscription",
  });
  subscriptionRead.getPrimaryOpenMeterSubscriptionForAppUser = async () => ({
    id: "om_sub_current",
  });
  subscriptionRead.resolveLocalPlanIdFromOpenMeterSubscription = async () =>
    current.id;
  return { app, current, target };
}

async function readCachedSubscription(
  app: SeededDeveloperApp,
  externalUserId: string,
) {
  const rows = await db
    .select()
    .from(subscriptions)
    .where(
      and(
        eq(subscriptions.clientId, app.clientId),
        eq(subscriptions.externalUserId, externalUserId),
      ),
    );
  return rows[0];
}

dbTest("createEndUserCheckout rejects a plan from another app", async (t) => {
  const app = await seedDeveloperAppWithClient();
  const other = await seedDeveloperAppWithClient();
  t.after(async () => {
    await cleanupTestApp(app);
    await cleanupTestApp(other);
  });
  const foreign = await seedPaidPlan(other.clientId);

  await assert.rejects(
    () =>
      sut.createEndUserCheckout({
        clientId: app.clientId,
        externalUserId: "end-user-1",
        planId: foreign.id,
      }),
    /Plan not found/,
  );
});

dbTest("createEndUserCheckout rejects a phased-out plan", async (t) => {
  const app = await seedDeveloperAppWithClient();
  t.after(() => cleanupTestApp(app));
  const plan = await seedPaidPlan(app.clientId, { status: "phase_out" });

  await assert.rejects(
    () =>
      sut.createEndUserCheckout({
        clientId: app.clientId,
        externalUserId: "end-user-1",
        planId: plan.id,
      }),
    /being phased out/,
  );
});

dbTest("createEndUserCheckout rejects an inactive plan", async (t) => {
  const app = await seedDeveloperAppWithClient();
  t.after(() => cleanupTestApp(app));
  const plan = await seedPaidPlan(app.clientId, { status: "draft" });

  await assert.rejects(
    () =>
      sut.createEndUserCheckout({
        clientId: app.clientId,
        externalUserId: "end-user-1",
        planId: plan.id,
      }),
    /Plan is not active/,
  );
});

dbTest("createEndUserCheckout rejects an unsynced plan", async (t) => {
  const app = await seedDeveloperAppWithClient();
  t.after(() => cleanupTestApp(app));
  const plan = await seedPaidPlan(app.clientId, { openmeterPlanId: null });

  await assert.rejects(
    () =>
      sut.createEndUserCheckout({
        clientId: app.clientId,
        externalUserId: "end-user-1",
        planId: plan.id,
      }),
    /not synced to OpenMeter/,
  );
});

dbTest("createEndUserCheckout requires merchant onboarding when connect-only", async (t) => {
  const app = await seedDeveloperAppWithClient();
  t.after(() => cleanupTestApp(app));
  const plan = await seedPaidPlan(app.clientId);
  merchantConnect.connectPaymentsOnlyEnabled = () => true;

  await assert.rejects(
    () =>
      sut.createEndUserCheckout({
        clientId: app.clientId,
        externalUserId: "end-user-1",
        planId: plan.id,
      }),
    /Stripe Connect onboarding is required/,
  );
});

dbTest("createEndUserCheckout rejects when OpenMeter returns no subscription", async (t) => {
  const app = await seedDeveloperAppWithClient();
  t.after(() => cleanupTestApp(app));
  const plan = await seedPaidPlan(app.clientId);
  subscriptionsCreate = async () => null;

  await assert.rejects(
    () =>
      sut.createEndUserCheckout({
        clientId: app.clientId,
        externalUserId: "end-user-1",
        planId: plan.id,
      }),
    /Failed to create OpenMeter subscription/,
  );
});

dbTest("createEndUserCheckout caches a pending row for the platform Stripe flow", async (t) => {
  const app = await seedDeveloperAppWithClient();
  t.after(() => cleanupTestApp(app));
  const plan = await seedPaidPlan(app.clientId);

  const result = await sut.createEndUserCheckout({
    clientId: app.clientId,
    externalUserId: "end-user-1",
    planId: plan.id,
  });
  assert.equal(result.checkoutUrl, "https://checkout.stripe.com/c/pay_openmeter");
  assert.equal(result.subscriptionId, "om_sub_created");
  assert.deepEqual(openMeterCreates, [
    { customerId: CUSTOMER_ID, planKey: buildOpenMeterPlanKey(app.clientId, plan.id) },
  ]);

  const cached = await readCachedSubscription(app, "end-user-1");
  assert.equal(cached?.status, "pending");
  assert.equal(cached?.planId, plan.id);
  assert.equal(cached?.stripeCheckoutSessionId, "cs_openmeter");
  assert.equal(cached?.openmeterSubscriptionId, "om_sub_created");
});

dbTest("createEndUserCheckout routes a merchant-ready app to Connect", async (t) => {
  const app = await seedDeveloperAppWithClient();
  t.after(() => cleanupTestApp(app));
  const plan = await seedPaidPlan(app.clientId);
  merchantConnect.isMerchantConnectPaymentsReady = () => true;
  billingProfiles.getAppBillingConfig = async () => ({
    checkoutSuccessUrl: "https://merchant.test/done",
    checkoutCancelUrl: "https://merchant.test/cancel",
  });

  const result = await sut.createEndUserCheckout({
    clientId: app.clientId,
    externalUserId: "end-user-1",
    planId: plan.id,
  });
  assert.match(result.checkoutUrl, /connect\?ok=/);
  assert.match(
    result.checkoutUrl,
    new RegExp(encodeURIComponent("https://merchant.test/done")),
  );

  const cached = await readCachedSubscription(app, "end-user-1");
  assert.equal(cached?.stripeCheckoutSessionId, "cs_connect");
});

dbTest("createEndUserCheckout falls back to app settings redirect urls", async (t) => {
  const app = await seedDeveloperAppWithClient();
  t.after(() => cleanupTestApp(app));
  const plan = await seedPaidPlan(app.clientId);
  const seen: Array<{ successUrl: string; cancelUrl: string }> = [];
  checkoutSession.createOpenMeterStripeCheckoutSession = async (input: {
    successUrl: string;
    cancelUrl: string;
  }) => {
    seen.push({ successUrl: input.successUrl, cancelUrl: input.cancelUrl });
    return { checkoutUrl: "https://checkout.stripe.com/c/pay_default", sessionId: null };
  };

  await sut.createEndUserCheckout({
    clientId: app.clientId,
    externalUserId: "end-user-1",
    planId: plan.id,
  });
  assert.deepEqual(seen, [
    {
      successUrl: `${ORIGIN}/apps/${app.clientId}/payments`,
      cancelUrl: `${ORIGIN}/apps/${app.clientId}/payments`,
    },
  ]);
});

dbTest("changeAppUserSubscriptionPlan creates a checkout when there is no subscription", async (t) => {
  const app = await seedDeveloperAppWithClient();
  t.after(() => cleanupTestApp(app));
  const plan = await seedPaidPlan(app.clientId);

  const result = await sut.changeAppUserSubscriptionPlan({
    clientId: app.clientId,
    externalUserId: "end-user-1",
    planId: plan.id,
  });
  assert.equal(result.subscriptionId, "om_sub_created");
  assert.equal(result.planId, plan.id);
  assert.equal(result.timing, "immediate");
  assert.equal(result.checkoutUrl, "https://checkout.stripe.com/c/pay_openmeter");
  assert.deepEqual(konnectChanges, []);
});

dbTest("changeAppUserSubscriptionPlan rejects a no-op plan change", async (t) => {
  const app = await seedDeveloperAppWithClient();
  t.after(() => cleanupTestApp(app));
  const plan = await seedPaidPlan(app.clientId);
  subscriptionRead.getPrimaryOpenMeterSubscriptionForAppUser = async () => ({
    id: "om_sub_current",
  });
  subscriptionRead.resolveLocalPlanIdFromOpenMeterSubscription = async () => plan.id;

  await assert.rejects(
    () =>
      sut.changeAppUserSubscriptionPlan({
        clientId: app.clientId,
        externalUserId: "end-user-1",
        planId: plan.id,
      }),
    /already on this plan/,
  );
});

dbTest("changeAppUserSubscriptionPlan requires Konnect routes", async (t) => {
  const app = await seedDeveloperAppWithClient();
  t.after(() => cleanupTestApp(app));
  const plan = await seedPaidPlan(app.clientId);
  subscriptionRead.getPrimaryOpenMeterSubscriptionForAppUser = async () => ({
    id: "om_sub_current",
  });
  process.env.OPENMETER_ROUTE_MODE = "self_hosted";

  await assert.rejects(
    () =>
      sut.changeAppUserSubscriptionPlan({
        clientId: app.clientId,
        externalUserId: "end-user-1",
        planId: plan.id,
      }),
    /requires Konnect routes/,
  );
});

dbTest("changeAppUserSubscriptionPlan downgrades at the next billing cycle", async (t) => {
  const { app, target } = await seedPlanChange(t, {
    currentPriceAmount: "50",
    targetPriceAmount: "0",
  });
  konnectSubscriptions.changeKonnectSubscription = async (input) => {
    konnectChanges.push(input);
    return { next: { id: "om_sub_next" } };
  };

  const result = await sut.changeAppUserSubscriptionPlan({
    clientId: app.clientId,
    externalUserId: "end-user-2",
    planId: target.id,
  });
  assert.equal(result.timing, "next_billing_cycle");
  assert.equal(result.subscriptionId, "om_sub_next");
  assert.equal(result.checkoutUrl, undefined);

  const cached = await readCachedSubscription(app, "end-user-2");
  assert.equal(cached?.status, "active");
  assert.equal(cached?.openmeterSubscriptionId, "om_sub_next");
});

dbTest("changeAppUserSubscriptionPlan keeps the cached row on a later change", async (t) => {
  const { app, target: second } = await seedPlanChange(t, {
    currentPriceAmount: "5",
    targetPriceAmount: "0",
  });

  await sut.changeAppUserSubscriptionPlan({
    clientId: app.clientId,
    externalUserId: "end-user-3",
    planId: second.id,
  });
  await sut.changeAppUserSubscriptionPlan({
    clientId: app.clientId,
    externalUserId: "end-user-3",
    planId: second.id,
    timing: "immediate",
  });

  const rows = await db
    .select()
    .from(subscriptions)
    .where(
      and(
        eq(subscriptions.clientId, app.clientId),
        eq(subscriptions.externalUserId, "end-user-3"),
      ),
    );
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.openmeterSubscriptionId, "om_sub_current");
});

dbTest("changeAppUserSubscriptionPlan collects a card when upgrading to a paid plan", async (t) => {
  const { app, target } = await seedPlanChange(t, {
    currentPriceAmount: "0",
    targetPriceAmount: "30",
  });

  const result = await sut.changeAppUserSubscriptionPlan({
    clientId: app.clientId,
    externalUserId: "end-user-4",
    planId: target.id,
    successUrl: "https://app.test/ok",
    cancelUrl: "https://app.test/no",
  });
  assert.equal(result.timing, "immediate");
  assert.equal(result.checkoutUrl, "https://checkout.stripe.com/c/pay_openmeter");

  const cached = await readCachedSubscription(app, "end-user-4");
  assert.equal(cached?.status, "pending");
});

dbTest("changeAppUserSubscriptionPlan skips checkout when a card is on file", async (t) => {
  const { app, target } = await seedPlanChange(t, {
    currentPriceAmount: "0",
    targetPriceAmount: "30",
  });
  stripeCustomerData.getKonnectDefaultPaymentMethodId = async () => "pm_existing";

  const result = await sut.changeAppUserSubscriptionPlan({
    clientId: app.clientId,
    externalUserId: "end-user-5",
    planId: target.id,
  });
  assert.equal(result.checkoutUrl, undefined);

  const cached = await readCachedSubscription(app, "end-user-5");
  assert.equal(cached?.status, "active");
});

dbTest("changeAppUserSubscriptionPlan uses Connect checkout for a merchant app", async (t) => {
  const { app, target } = await seedPlanChange(t, {
    currentPriceAmount: "0",
    targetPriceAmount: "30",
  });
  merchantConnect.isMerchantConnectPaymentsReady = () => true;

  const result = await sut.changeAppUserSubscriptionPlan({
    clientId: app.clientId,
    externalUserId: "end-user-6",
    planId: target.id,
  });
  assert.match(result.checkoutUrl ?? "", /connect\?ok=/);

  const cached = await readCachedSubscription(app, "end-user-6");
  assert.equal(cached?.stripeCheckoutSessionId, "cs_connect");
});

dbTest("changeAppUserSubscriptionPlan blocks a paid upgrade for a connect-only app", async (t) => {
  const { app, target } = await seedPlanChange(t, {
    currentPriceAmount: "0",
    targetPriceAmount: "30",
  });
  merchantConnect.connectPaymentsOnlyEnabled = () => true;

  await assert.rejects(
    () =>
      sut.changeAppUserSubscriptionPlan({
        clientId: app.clientId,
        externalUserId: "end-user-7",
        planId: target.id,
      }),
    /Stripe Connect onboarding is required/,
  );
});

dbTest("changeAppUserSubscriptionPlan falls back to the current subscription id", async (t) => {
  const { app, target } = await seedPlanChange(t, {
    currentPriceAmount: "5",
    targetPriceAmount: "0",
  });
  konnectSubscriptions.changeKonnectSubscription = async (input) => {
    konnectChanges.push(input);
    return {};
  };

  const result = await sut.changeAppUserSubscriptionPlan({
    clientId: app.clientId,
    externalUserId: "end-user-8",
    planId: target.id,
  });
  assert.equal(result.subscriptionId, "om_sub_current");
  assert.equal(konnectChanges[0]?.planId, target.openmeterPlanId);
});

dbTest("changeAppUserSubscriptionPlan treats an unmapped current plan as an upgrade", async (t) => {
  const app = await seedDeveloperAppWithClient();
  t.after(() => cleanupTestApp(app));
  const target = await seedPaidPlan(app.clientId, { priceAmount: "30" });
  subscriptionRead.getPrimaryOpenMeterSubscriptionForAppUser = async () => ({
    id: "om_sub_current",
  });
  subscriptionRead.resolveLocalPlanIdFromOpenMeterSubscription = async () => null;

  const result = await sut.changeAppUserSubscriptionPlan({
    clientId: app.clientId,
    externalUserId: "end-user-9",
    planId: target.id,
  });
  assert.equal(result.timing, "immediate");
});
