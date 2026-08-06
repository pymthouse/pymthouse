import { and, eq } from "drizzle-orm";
import { v4 as uuidv4 } from "uuid";
import { db } from "@/db/index";
import { plans, subscriptions } from "@/db/schema";
import { appSettingsAbsoluteUrl } from "@/lib/apps/settings-paths";
import { getPublicOrigin } from "@/lib/oidc/issuer-urls";
import { getHostedAdminClient } from "./admin-client";
import {
  applyTenantBillingProfileToCustomer,
  getAppBillingConfig,
  prepareAppCustomerStripeBilling,
} from "./billing-profiles";
import { getHostedOpenMeterUrl } from "./constants";
import { buildOpenMeterCustomerKey } from "./customer-key";
import { ensureOpenMeterCustomerForAppUser } from "./customers";
import {
  changeKonnectSubscription,
  type SubscriptionChangeTiming,
} from "./konnect-subscriptions";
import { buildOpenMeterPlanKey } from "./plans-sync";
import { shouldUseKonnectRoutes } from "./route-mode";
import {
  getPrimaryOpenMeterSubscriptionForAppUser,
  resolveLocalPlanIdFromOpenMeterSubscription,
} from "./subscription-read";
import { createOpenMeterStripeCheckoutSession } from "./stripe-checkout-session";
import { getKonnectDefaultPaymentMethodId } from "./stripe-customer-data";
import {
  connectPaymentsOnlyEnabled,
  createMerchantConnectCheckoutForUser,
  isMerchantConnectPaymentsReady,
} from "@/lib/stripe/merchant-connect";

function parsePlanPriceAmount(raw: string | null | undefined): number {
  const n = Number.parseFloat(String(raw ?? "0").trim() || "0");
  return Number.isFinite(n) ? n : 0;
}

/** True when the plan bills a flat subscription fee that needs a payment method. */
export function planRequiresPaymentMethod(plan: {
  type: string;
  priceAmount: string;
  isStarterDefault?: boolean | null;
  isNetworkDefault?: boolean | null;
}): boolean {
  if (plan.isStarterDefault || plan.isNetworkDefault || plan.type === "free") {
    return false;
  }
  return plan.type === "subscription" && parsePlanPriceAmount(plan.priceAmount) > 0;
}

export function defaultSubscriptionChangeTiming(input: {
  currentPriceAmount: string | null | undefined;
  targetPriceAmount: string;
}): SubscriptionChangeTiming {
  const current = parsePlanPriceAmount(input.currentPriceAmount);
  const target = parsePlanPriceAmount(input.targetPriceAmount);
  return target > current ? "immediate" : "next_billing_cycle";
}

/**
 * Neon subscription cache status after a plan change.
 * When Checkout is required to collect a payment method, keep the row pending
 * until Stripe completes (mirrors createEndUserCheckout).
 */
export function neonSubscriptionStatusAfterPlanChange(input: {
  checkoutUrl?: string;
}): "pending" | "active" {
  return input.checkoutUrl ? "pending" : "active";
}

async function checkoutUrlAfterPlanChange(input: {
  client: ReturnType<typeof getHostedAdminClient>;
  clientId: string;
  externalUserId: string;
  targetPlan: Awaited<ReturnType<typeof loadActiveTargetPlan>>;
  customer: { id: string; key: string };
  successUrl?: string;
  cancelUrl?: string;
}): Promise<{ checkoutUrl?: string; stripeCheckoutSessionId?: string | null }> {
  if (!planRequiresPaymentMethod(input.targetPlan)) {
    return {};
  }

  const billingConfig = await getAppBillingConfig(input.clientId);
  const origin = getPublicOrigin();
  const success =
    input.successUrl ||
    billingConfig?.checkoutSuccessUrl ||
    appSettingsAbsoluteUrl(origin, input.clientId, "payments");
  const cancel =
    input.cancelUrl ||
    billingConfig?.checkoutCancelUrl ||
    appSettingsAbsoluteUrl(origin, input.clientId, "payments");

  if (isMerchantConnectPaymentsReady(billingConfig)) {
    const connectCheckout = await createMerchantConnectCheckoutForUser({
      clientId: input.clientId,
      externalUserId: input.externalUserId,
      successUrl: success,
      cancelUrl: cancel,
      openmeterCustomerId: input.customer.id,
      openmeterCustomerKey: input.customer.key,
    });
    return {
      checkoutUrl: connectCheckout.checkoutUrl,
      stripeCheckoutSessionId: connectCheckout.sessionId,
    };
  }

  const paymentMethodId = await getKonnectDefaultPaymentMethodId(input.customer.id);
  if (paymentMethodId) {
    return {};
  }

  if (connectPaymentsOnlyEnabled(billingConfig)) {
    throw new Error(
      "Merchant Stripe Connect onboarding is required before checkout (connectPaymentsOnly)",
    );
  }

  const checkout = await createOpenMeterStripeCheckoutSession({
    client: input.client,
    customerId: input.customer.id,
    successUrl: success,
    cancelUrl: cancel,
  });
  return {
    checkoutUrl: checkout.checkoutUrl,
    stripeCheckoutSessionId: checkout.sessionId,
  };
}

async function upsertNeonSubscriptionCache(input: {
  clientId: string;
  externalUserId: string;
  planId: string;
  openmeterSubscriptionId: string;
  status: string;
  stripeCheckoutSessionId?: string | null;
}): Promise<void> {
  const customerKey = buildOpenMeterCustomerKey(
    input.clientId,
    input.externalUserId,
  );
  const existing = await db
    .select()
    .from(subscriptions)
    .where(
      and(
        eq(subscriptions.clientId, input.clientId),
        eq(subscriptions.externalUserId, input.externalUserId),
      ),
    )
    .limit(1);

  const now = new Date().toISOString();
  if (existing[0]) {
    await db
      .update(subscriptions)
      .set({
        planId: input.planId,
        status: input.status,
        openmeterSubscriptionId: input.openmeterSubscriptionId,
        openmeterCustomerKey: customerKey,
        externalUserId: input.externalUserId,
        ...(input.stripeCheckoutSessionId !== undefined
          ? { stripeCheckoutSessionId: input.stripeCheckoutSessionId }
          : {}),
      })
      .where(eq(subscriptions.id, existing[0].id));
    return;
  }

  await db.insert(subscriptions).values({
    id: uuidv4(),
    userId: null,
    clientId: input.clientId,
    planId: input.planId,
    status: input.status,
    openmeterSubscriptionId: input.openmeterSubscriptionId,
    openmeterCustomerKey: customerKey,
    externalUserId: input.externalUserId,
    stripeCheckoutSessionId: input.stripeCheckoutSessionId ?? null,
    createdAt: now,
  });
}

async function loadActiveTargetPlan(input: {
  clientId: string;
  planId: string;
}): Promise<typeof plans.$inferSelect> {
  const planRows = await db
    .select()
    .from(plans)
    .where(eq(plans.id, input.planId))
    .limit(1);
  const plan = planRows[0];
  if (plan?.clientId !== input.clientId) {
    throw new Error("Plan not found");
  }
  if (plan.status !== "active") {
    throw new Error(
      plan.status === "phase_out"
        ? "Plan is being phased out and cannot accept new subscribers"
        : "Plan is not active",
    );
  }
  if (!plan.openmeterPlanId) {
    throw new Error("Plan is not synced to OpenMeter");
  }
  return plan;
}

export async function createEndUserCheckout(input: {
  clientId: string;
  externalUserId: string;
  planId: string;
  successUrl?: string;
  cancelUrl?: string;
}): Promise<{ checkoutUrl: string; subscriptionId?: string }> {
  const plan = await loadActiveTargetPlan({
    clientId: input.clientId,
    planId: input.planId,
  });

  const client = getHostedAdminClient();
  const customer = await ensureOpenMeterCustomerForAppUser({
    client,
    clientId: input.clientId,
    externalUserId: input.externalUserId,
  });
  await prepareAppCustomerStripeBilling({
    client,
    clientId: input.clientId,
    customerId: customer.id,
    customerKey: customer.key,
  });
  await applyTenantBillingProfileToCustomer({
    client,
    clientId: input.clientId,
    customerId: customer.id,
    customerKey: customer.key,
  });

  const billingConfig = await getAppBillingConfig(input.clientId);
  const merchantReady = isMerchantConnectPaymentsReady(billingConfig);
  if (!merchantReady && connectPaymentsOnlyEnabled(billingConfig)) {
    throw new Error(
      "Merchant Stripe Connect onboarding is required before checkout (connectPaymentsOnly)",
    );
  }

  const planKey = buildOpenMeterPlanKey(input.clientId, plan.id);
  const subscription = await client.subscriptions.create({
    customerId: customer.id,
    plan: { key: planKey },
  });
  if (!subscription?.id) {
    throw new Error("Failed to create OpenMeter subscription");
  }

  const origin = getPublicOrigin();
  const success =
    input.successUrl ||
    billingConfig?.checkoutSuccessUrl ||
    appSettingsAbsoluteUrl(origin, input.clientId, "payments");
  const cancel =
    input.cancelUrl ||
    billingConfig?.checkoutCancelUrl ||
    appSettingsAbsoluteUrl(origin, input.clientId, "payments");

  let checkoutUrl: string;
  let stripeCheckoutSessionId: string | null = null;

  if (merchantReady) {
    const connectCheckout = await createMerchantConnectCheckoutForUser({
      clientId: input.clientId,
      externalUserId: input.externalUserId,
      successUrl: success,
      cancelUrl: cancel,
      openmeterCustomerId: customer.id,
      openmeterCustomerKey: customer.key,
    });
    checkoutUrl = connectCheckout.checkoutUrl;
    stripeCheckoutSessionId = connectCheckout.sessionId;
  } else {
    const checkout = await createOpenMeterStripeCheckoutSession({
      client,
      customerId: customer.id,
      successUrl: success,
      cancelUrl: cancel,
    });
    checkoutUrl = checkout.checkoutUrl;
    stripeCheckoutSessionId = checkout.sessionId;
  }

  await upsertNeonSubscriptionCache({
    clientId: input.clientId,
    externalUserId: input.externalUserId,
    planId: plan.id,
    openmeterSubscriptionId: subscription.id,
    status: "pending",
    stripeCheckoutSessionId,
  });

  return { checkoutUrl, subscriptionId: subscription.id };
}

export type ChangeAppUserSubscriptionPlanResult = {
  subscriptionId: string;
  planId: string;
  effectiveAt: string | null;
  timing: SubscriptionChangeTiming;
  checkoutUrl?: string;
};

/**
 * Switch an end-user onto another active plan via Konnect subscription change.
 * Falls back to create+checkout when the user has no current subscription.
 */
export async function changeAppUserSubscriptionPlan(input: {
  clientId: string;
  externalUserId: string;
  planId: string;
  timing?: SubscriptionChangeTiming;
  successUrl?: string;
  cancelUrl?: string;
}): Promise<ChangeAppUserSubscriptionPlanResult> {
  const targetPlan = await loadActiveTargetPlan({
    clientId: input.clientId,
    planId: input.planId,
  });

  const current = await getPrimaryOpenMeterSubscriptionForAppUser({
    clientId: input.clientId,
    externalUserId: input.externalUserId,
  });

  if (!current) {
    const created = await createEndUserCheckout({
      clientId: input.clientId,
      externalUserId: input.externalUserId,
      planId: input.planId,
      successUrl: input.successUrl,
      cancelUrl: input.cancelUrl,
    });
    return {
      subscriptionId: created.subscriptionId ?? "",
      planId: targetPlan.id,
      effectiveAt: new Date().toISOString(),
      timing: "immediate",
      checkoutUrl: created.checkoutUrl,
    };
  }

  const currentLocalPlanId = await resolveLocalPlanIdFromOpenMeterSubscription(
    input.clientId,
    current,
  );
  const currentPlanRows = currentLocalPlanId
    ? await db.select().from(plans).where(eq(plans.id, currentLocalPlanId)).limit(1)
    : [];
  const currentLocalPlan = currentPlanRows[0] ?? null;

  if (currentLocalPlan?.id === targetPlan.id) {
    throw new Error("User is already on this plan");
  }

  if (
    !shouldUseKonnectRoutes(
      getHostedOpenMeterUrl(),
      process.env.OPENMETER_API_KEY,
    )
  ) {
    throw new Error(
      "Plan change requires Konnect routes (set OPENMETER_ROUTE_MODE=hosted " +
        "or point OPENMETER_URL at a Konnect metering endpoint).",
    );
  }

  const timing =
    input.timing ??
    defaultSubscriptionChangeTiming({
      currentPriceAmount: currentLocalPlan?.priceAmount,
      targetPriceAmount: targetPlan.priceAmount,
    });

  const client = getHostedAdminClient();
  const customer = await ensureOpenMeterCustomerForAppUser({
    client,
    clientId: input.clientId,
    externalUserId: input.externalUserId,
  });
  await prepareAppCustomerStripeBilling({
    client,
    clientId: input.clientId,
    customerId: customer.id,
    customerKey: customer.key,
  });

  const change = await changeKonnectSubscription({
    subscriptionId: current.id,
    customerId: customer.id,
    planId: targetPlan.openmeterPlanId!,
    timing,
  });

  const nextSubscriptionId =
    change.next?.id?.trim() ||
    change.current?.id?.trim() ||
    current.id;
  const effectiveAt = new Date().toISOString();

  const { checkoutUrl, stripeCheckoutSessionId } = await checkoutUrlAfterPlanChange({
    client,
    clientId: input.clientId,
    externalUserId: input.externalUserId,
    targetPlan,
    customer,
    successUrl: input.successUrl,
    cancelUrl: input.cancelUrl,
  });

  await upsertNeonSubscriptionCache({
    clientId: input.clientId,
    externalUserId: input.externalUserId,
    planId: targetPlan.id,
    openmeterSubscriptionId: nextSubscriptionId,
    status: neonSubscriptionStatusAfterPlanChange({ checkoutUrl }),
    stripeCheckoutSessionId,
  });

  return {
    subscriptionId: nextSubscriptionId,
    planId: targetPlan.id,
    effectiveAt,
    timing,
    ...(checkoutUrl ? { checkoutUrl } : {}),
  };
}
