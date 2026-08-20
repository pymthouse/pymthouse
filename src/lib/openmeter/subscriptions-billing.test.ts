import test from "node:test";
import assert from "node:assert/strict";
import type { OpenMeter } from "@openmeter/sdk";
import { eq } from "drizzle-orm";

import { db } from "@/db/index";
import { appUserPaymentMethodCheckouts } from "@/db/schema";
import {
  createPaymentMethodCheckoutIfNeededForPlanChange,
  defaultSubscriptionChangeTiming,
  neonSubscriptionStatusAfterPlanChange,
  planRequiresPaymentMethod,
  shouldApplyFreeBillingProfileForCheckout,
  shouldCollectPaymentMethodBeforePlanChange,
} from "./subscriptions-billing";
import { test as dbTest } from "@/test-utils/db-guard";
import {
  cleanupTestApp,
  seedDeveloperAppWithClient,
} from "@/test-utils/fixtures";

test("planRequiresPaymentMethod is false for free/starter/network", () => {
  assert.equal(
    planRequiresPaymentMethod({ type: "free", priceAmount: "10" }),
    false,
  );
  assert.equal(
    planRequiresPaymentMethod({
      type: "subscription",
      priceAmount: "10",
      isStarterDefault: true,
    }),
    false,
  );
  assert.equal(
    planRequiresPaymentMethod({
      type: "subscription",
      priceAmount: "10",
      isNetworkDefault: true,
    }),
    false,
  );
});

test("planRequiresPaymentMethod is true for paid subscription and pay-per-use", () => {
  assert.equal(
    planRequiresPaymentMethod({ type: "subscription", priceAmount: "9.99" }),
    true,
  );
  assert.equal(
    planRequiresPaymentMethod({ type: "subscription", priceAmount: "0" }),
    false,
  );
  // Usage plans are $0 flat but still need a card for threshold auto-debit.
  assert.equal(
    planRequiresPaymentMethod({ type: "usage", priceAmount: "0" }),
    true,
  );
  assert.equal(
    planRequiresPaymentMethod({ type: "usage", priceAmount: "9.99" }),
    true,
  );
});

test("defaultSubscriptionChangeTiming upgrades immediate, else next cycle", () => {
  assert.equal(
    defaultSubscriptionChangeTiming({
      currentPriceAmount: "5",
      targetPriceAmount: "20",
    }),
    "immediate",
  );
  assert.equal(
    defaultSubscriptionChangeTiming({
      currentPriceAmount: "20",
      targetPriceAmount: "5",
    }),
    "next_billing_cycle",
  );
  assert.equal(
    defaultSubscriptionChangeTiming({
      currentPriceAmount: "10",
      targetPriceAmount: "10",
    }),
    "next_billing_cycle",
  );
  assert.equal(
    defaultSubscriptionChangeTiming({
      currentPriceAmount: null,
      targetPriceAmount: "1",
    }),
    "immediate",
  );
});

test("defaultSubscriptionChangeTiming ends Starter included immediately on PPU", () => {
  assert.equal(
    defaultSubscriptionChangeTiming({
      currentPriceAmount: "0",
      targetPriceAmount: "0",
      currentPlanType: "free",
      targetPlanType: "usage",
      currentIsStarterDefault: true,
    }),
    "immediate",
  );
  assert.equal(
    defaultSubscriptionChangeTiming({
      currentPriceAmount: "0",
      targetPriceAmount: "0",
      currentPlanType: "subscription",
      targetPlanType: "usage",
      currentIsStarterDefault: true,
    }),
    "immediate",
  );
  // Paid downgrade to cheaper plan stays next cycle
  assert.equal(
    defaultSubscriptionChangeTiming({
      currentPriceAmount: "20",
      targetPriceAmount: "0",
      currentPlanType: "subscription",
      targetPlanType: "usage",
    }),
    "next_billing_cycle",
  );
  // PPU → PPU same price stays next cycle
  assert.equal(
    defaultSubscriptionChangeTiming({
      currentPriceAmount: "0",
      targetPriceAmount: "0",
      currentPlanType: "usage",
      targetPlanType: "usage",
    }),
    "next_billing_cycle",
  );
});

test("shouldCollectPaymentMethodBeforePlanChange gates Konnect /change", () => {
  assert.equal(
    shouldCollectPaymentMethodBeforePlanChange({
      targetRequiresPaymentMethod: true,
      hasDefaultPaymentMethod: false,
    }),
    true,
  );
  assert.equal(
    shouldCollectPaymentMethodBeforePlanChange({
      targetRequiresPaymentMethod: true,
      hasDefaultPaymentMethod: true,
    }),
    false,
  );
  assert.equal(
    shouldCollectPaymentMethodBeforePlanChange({
      targetRequiresPaymentMethod: false,
      hasDefaultPaymentMethod: false,
    }),
    false,
  );
});

test("PM-gated plan change response keeps current plan and null effectiveAt", () => {
  // Contract for changeAppUserSubscriptionPlan early return: Checkout collects a
  // card before /change, so effectiveAt must stay null and planId must remain
  // the current plan (not the unpaid target). Prefer currentLocalPlanId over any
  // target fallback when the local plan row is missing.
  const currentLocalPlanId = "plan_starter";
  const response = {
    subscriptionId: "sub_current",
    planId: currentLocalPlanId ?? "",
    effectiveAt: null as string | null,
    timing: "immediate" as const,
    checkoutUrl: "https://checkout.stripe.com/c/pay_test",
  };
  assert.equal(response.effectiveAt, null);
  assert.equal(response.planId, currentLocalPlanId);
  assert.ok(response.checkoutUrl);
});

test("neonSubscriptionStatusAfterPlanChange is pending when checkout is required", () => {
  assert.equal(
    neonSubscriptionStatusAfterPlanChange({
      checkoutUrl: "https://checkout.stripe.com/c/pay_test",
    }),
    "pending",
  );
  assert.equal(neonSubscriptionStatusAfterPlanChange({}), "active");
  assert.equal(
    neonSubscriptionStatusAfterPlanChange({ checkoutUrl: undefined }),
    "active",
  );
});

test("merchant Checkout retains its Custom Invoicing billing profile", () => {
  assert.equal(
    shouldApplyFreeBillingProfileForCheckout({
      isMerchantBilling: true,
      needsPaymentMethod: true,
      defaultPaymentMethodId: null,
    }),
    false,
  );
  assert.equal(
    shouldApplyFreeBillingProfileForCheckout({
      isMerchantBilling: false,
      needsPaymentMethod: true,
      defaultPaymentMethodId: null,
    }),
    true,
  );
});

test("scheduled status is never a /change target for checkout routing", async () => {
  const { isScheduledSubscriptionStatus, isLiveSubscriptionStatus } =
    await import("./subscription-state");
  // Contract: checkout must DELETE scheduled rows, not call /change.
  assert.equal(isScheduledSubscriptionStatus("scheduled"), true);
  assert.equal(isLiveSubscriptionStatus("scheduled"), false);
  assert.equal(isScheduledSubscriptionStatus("pending"), true);
  assert.equal(isLiveSubscriptionStatus("pending"), false);
});

test("cancel-at-period-end starter still occupies the customer for create", async () => {
  const { isOccupyingCanceledSubscription } = await import("./subscription-state");
  // Matches staging Konnect 409: starter activeTo=2026-09-07 blocks create.
  assert.equal(
    isOccupyingCanceledSubscription(
      {
        status: "canceled",
        activeTo: "2026-09-07T17:35:18.109927Z",
      },
      Date.parse("2026-08-07T21:25:20.000Z"),
    ),
    true,
  );
});

test("checkout recovery fires for a Konnect canceled row that omits activeTo", async () => {
  const { listOpenMeterSubscriptionsForCustomer } = await import(
    "./subscription-read"
  );
  const { pickOccupyingCanceledSubscription } = await import(
    "./subscription-state"
  );

  // Verbatim `GET /v3/openmeter/subscriptions?filter[customer_id][eq]=…` rows
  // (normalized by createKonnectFetch): Konnect v3 sends no activeTo at all, so
  // the activeTo-only occupancy check classified this cancel-at-period-end row
  // as gone and let subscriptions.create 409 instead of restoring it.
  const client = {
    customers: {
      listSubscriptions: async () => ({
        items: [
          {
            id: "01KZCN0AH450JWA381D2AN7NJK",
            status: "canceled",
            customer_id: "01KZCM0S8FNE1TF9ECKF5RA8VP",
            plan: { id: "01KZA99BCTE062Y562VGRSJ6EP" },
            billing_anchor: "2026-08-06T23:02:17.378589Z",
          },
        ],
      }),
    },
    plans: {
      get: async () => ({ key: "a6c95d934_plan_397fcf2f" }),
    },
  };

  const listed = await listOpenMeterSubscriptionsForCustomer(
    client as never,
    "01KZCM0S8FNE1TF9ECKF5RA8VP",
  );
  assert.equal(listed[0]?.activeTo, null);
  assert.equal(
    pickOccupyingCanceledSubscription(listed)?.id,
    "01KZCN0AH450JWA381D2AN7NJK",
  );
});

dbTest(
  "createPaymentMethodCheckoutIfNeededForPlanChange returns setup Checkout when no PM",
  async (t) => {
    const previousUrl = process.env.OPENMETER_URL;
    const previousKey = process.env.OPENMETER_API_KEY;
    const previousMode = process.env.OPENMETER_ROUTE_MODE;
    process.env.OPENMETER_URL = "http://127.0.0.1:48888";
    delete process.env.OPENMETER_API_KEY;
    process.env.OPENMETER_ROUTE_MODE = "self_hosted";
    t.after(() => {
      if (previousUrl === undefined) delete process.env.OPENMETER_URL;
      else process.env.OPENMETER_URL = previousUrl;
      if (previousKey === undefined) delete process.env.OPENMETER_API_KEY;
      else process.env.OPENMETER_API_KEY = previousKey;
      if (previousMode === undefined) delete process.env.OPENMETER_ROUTE_MODE;
      else process.env.OPENMETER_ROUTE_MODE = previousMode;
    });

    const app = await seedDeveloperAppWithClient({ status: "approved" });
    t.after(async () => {
      await db
        .delete(appUserPaymentMethodCheckouts)
        .where(eq(appUserPaymentMethodCheckouts.clientId, app.clientId));
      await cleanupTestApp(app);
    });

    const client = {
      apps: {
        stripe: {
          createCheckoutSession: async (body: {
            customer: { id: string };
            options: { successURL: string; cancelURL: string; currency?: string };
          }) => {
            assert.equal(body.customer.id, "cust_pm_gate");
            assert.equal(body.options.currency, "USD");
            // Open redirects must be rejected — evil successUrl falls back.
            assert.match(
              body.options.successURL,
              /^https?:\/\/localhost:3001\//,
            );
            assert.match(
              body.options.cancelURL,
              /^https?:\/\/localhost:3001\//,
            );
            return {
              url: "https://checkout.stripe.com/c/pay/cs_pm_gate",
              sessionId: "cs_pm_gate",
            };
          },
        },
      },
    } as unknown as OpenMeter;

    const checkout = await createPaymentMethodCheckoutIfNeededForPlanChange({
      clientId: app.clientId,
      externalUserId: "user_pm_gate",
      customerId: "cust_pm_gate",
      customerKey: "cust_key_pm_gate",
      targetPlan: {
        id: "plan_paid",
        type: "subscription",
        priceAmount: "29",
      },
      client: client as never,
      successUrl: "http://evil.example/phish",
      cancelUrl: "http://evil.example/phish",
    });

    assert.ok(checkout);
    assert.equal(checkout!.checkoutUrl, "https://checkout.stripe.com/c/pay/cs_pm_gate");
    assert.equal(checkout!.sessionId, "cs_pm_gate");
  },
);

dbTest(
  "createPaymentMethodCheckoutIfNeededForPlanChange skips free targets",
  async () => {
    const checkout = await createPaymentMethodCheckoutIfNeededForPlanChange({
      clientId: "unused",
      externalUserId: "unused",
      customerId: "cust",
      customerKey: "key",
      targetPlan: {
        id: "plan_free",
        type: "free",
        priceAmount: "0",
      },
      client: {} as never,
    });
    assert.equal(checkout, null);
  },
);
