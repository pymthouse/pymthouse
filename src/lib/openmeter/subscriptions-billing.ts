import { and, eq } from "drizzle-orm";
import { v4 as uuidv4 } from "uuid";
import { db } from "@/db/index";
import { plans, subscriptions } from "@/db/schema";
import { getHostedAdminClient } from "./admin-client";
import {
  applyTenantBillingProfileToCustomer,
  getAppBillingConfig,
  upsertAppBillingConfig,
} from "./billing-profiles";
import { buildOpenMeterCustomerKey } from "./customer-key";
import { ensureOpenMeterCustomerForAppUser } from "./customers";
import { buildOpenMeterPlanKey } from "./plans-sync";
import { getCustomerPlanOverride } from "./customer-plan-overrides";
import { getPublicOrigin } from "@/lib/oidc/issuer-urls";
import {
  getPrimaryOpenMeterSubscriptionForAppUser,
  isOpenMeterSubscriptionActive,
} from "./subscription-read";

export type SubscriptionTimingMode = "immediate" | "next_billing_cycle";

async function resolveCheckoutPlanId(input: {
  clientId: string;
  externalUserId: string;
  planId: string;
}): Promise<string> {
  const override = await getCustomerPlanOverride({
    clientId: input.clientId,
    externalUserId: input.externalUserId,
  });
  return override?.planId || input.planId;
}

async function upsertLocalSubscriptionCache(input: {
  clientId: string;
  externalUserId: string;
  planId: string;
  status: string;
  openmeterSubscriptionId: string;
  customerKey: string;
  stripeCheckoutSessionId?: string | null;
  cancelledAt?: string | null;
  currentPeriodStart?: string | null;
  currentPeriodEnd?: string | null;
}): Promise<void> {
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
        openmeterCustomerKey: input.customerKey,
        externalUserId: input.externalUserId,
        stripeCheckoutSessionId:
          input.stripeCheckoutSessionId === undefined
            ? existing[0].stripeCheckoutSessionId
            : input.stripeCheckoutSessionId,
        cancelledAt:
          input.cancelledAt === undefined ? existing[0].cancelledAt : input.cancelledAt,
        currentPeriodStart: input.currentPeriodStart ?? existing[0].currentPeriodStart,
        currentPeriodEnd: input.currentPeriodEnd ?? existing[0].currentPeriodEnd,
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
    openmeterCustomerKey: input.customerKey,
    externalUserId: input.externalUserId,
    stripeCheckoutSessionId: input.stripeCheckoutSessionId ?? null,
    cancelledAt: input.cancelledAt ?? null,
    currentPeriodStart: input.currentPeriodStart ?? null,
    currentPeriodEnd: input.currentPeriodEnd ?? null,
    createdAt: now,
  });
}

export async function createEndUserCheckout(input: {
  clientId: string;
  externalUserId: string;
  planId: string;
  successUrl?: string;
  cancelUrl?: string;
}): Promise<{ checkoutUrl: string; subscriptionId?: string }> {
  const resolvedPlanId = await resolveCheckoutPlanId({
    clientId: input.clientId,
    externalUserId: input.externalUserId,
    planId: input.planId,
  });
  const planRows = await db
    .select()
    .from(plans)
    .where(eq(plans.id, resolvedPlanId))
    .limit(1);
  const plan = planRows[0];
  if (plan?.clientId !== input.clientId) {
    throw new Error("Plan not found");
  }
  if (!plan.openmeterPlanId) {
    throw new Error("Plan is not synced to OpenMeter");
  }

  const billingConfig = await getAppBillingConfig(input.clientId);
  if (billingConfig?.stripeConnectStatus !== "connected") {
    throw new Error("Stripe is not connected for this app");
  }

  const client = getHostedAdminClient();
  const customer = await ensureOpenMeterCustomerForAppUser({
    client,
    clientId: input.clientId,
    externalUserId: input.externalUserId,
  });
  await applyTenantBillingProfileToCustomer({
    client,
    clientId: input.clientId,
    customerId: customer.id,
  });

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
    `${origin}/apps/${input.clientId}/settings?tab=payments`;
  const cancel =
    input.cancelUrl ||
    billingConfig?.checkoutCancelUrl ||
    `${origin}/apps/${input.clientId}/settings?tab=payments`;

  const checkout = await client.apps.stripe.createCheckoutSession({
    customer: { id: customer.id },
    options: {
      successURL: success,
      cancelURL: cancel,
    },
  });

  if (!checkout?.url) {
    throw new Error("Stripe checkout session URL unavailable");
  }

  const customerKey = buildOpenMeterCustomerKey(input.clientId, input.externalUserId);
  await upsertLocalSubscriptionCache({
    clientId: input.clientId,
    externalUserId: input.externalUserId,
    planId: plan.id,
    status: "pending",
    openmeterSubscriptionId: subscription.id,
    customerKey,
    stripeCheckoutSessionId: checkout.sessionId ?? null,
  });

  return { checkoutUrl: checkout.url, subscriptionId: subscription.id };
}

export async function cancelEndUserSubscription(input: {
  clientId: string;
  externalUserId: string;
  timing?: SubscriptionTimingMode;
}): Promise<{
  subscriptionId: string;
  status: string;
  timing: SubscriptionTimingMode;
}> {
  const primary = await getPrimaryOpenMeterSubscriptionForAppUser({
    clientId: input.clientId,
    externalUserId: input.externalUserId,
  });
  if (!primary || !isOpenMeterSubscriptionActive(primary.status)) {
    throw new Error("No active subscription found");
  }

  const timing = input.timing ?? "next_billing_cycle";
  const client = getHostedAdminClient();
  const cancelled = await client.subscriptions.cancel(primary.id, { timing });
  if (!cancelled?.id) {
    throw new Error("Failed to cancel OpenMeter subscription");
  }

  const customerKey = buildOpenMeterCustomerKey(input.clientId, input.externalUserId);
  const localPlanId =
    (await db
      .select({ id: plans.id })
      .from(plans)
      .where(and(eq(plans.clientId, input.clientId), eq(plans.openmeterPlanId, primary.planId ?? "")))
      .limit(1))[0]?.id ??
    (
      await db
        .select({ planId: subscriptions.planId })
        .from(subscriptions)
        .where(
          and(
            eq(subscriptions.clientId, input.clientId),
            eq(subscriptions.externalUserId, input.externalUserId),
          ),
        )
        .limit(1)
    )[0]?.planId;

  if (localPlanId) {
    await upsertLocalSubscriptionCache({
      clientId: input.clientId,
      externalUserId: input.externalUserId,
      planId: localPlanId,
      status: cancelled.status ?? "canceled",
      openmeterSubscriptionId: cancelled.id,
      customerKey,
      cancelledAt: new Date().toISOString(),
      currentPeriodStart: primary.activeFrom,
      currentPeriodEnd: primary.activeTo,
    });
  }

  return {
    subscriptionId: cancelled.id,
    status: String(cancelled.status ?? "canceled"),
    timing,
  };
}

export async function changeEndUserSubscription(input: {
  clientId: string;
  externalUserId: string;
  planId: string;
  timing?: SubscriptionTimingMode;
}): Promise<{
  previousSubscriptionId: string;
  subscriptionId: string;
  planId: string;
  status: string;
  timing: SubscriptionTimingMode;
}> {
  const planRows = await db
    .select()
    .from(plans)
    .where(eq(plans.id, input.planId))
    .limit(1);
  const plan = planRows[0];
  if (plan?.clientId !== input.clientId) {
    throw new Error("Plan not found");
  }
  if (!plan.openmeterPlanId || plan.status !== "active") {
    throw new Error("Plan is not synced to OpenMeter");
  }
  if (plan.type === "free" || plan.isNetworkDefault) {
    throw new Error("Cannot change subscription to a non-billable plan");
  }

  const primary = await getPrimaryOpenMeterSubscriptionForAppUser({
    clientId: input.clientId,
    externalUserId: input.externalUserId,
  });
  if (!primary || !isOpenMeterSubscriptionActive(primary.status)) {
    throw new Error("No active subscription found");
  }

  const timing = input.timing ?? "immediate";
  const client = getHostedAdminClient();
  const customer = await ensureOpenMeterCustomerForAppUser({
    client,
    clientId: input.clientId,
    externalUserId: input.externalUserId,
  });
  await applyTenantBillingProfileToCustomer({
    client,
    clientId: input.clientId,
    customerId: customer.id,
  });

  const planKey = buildOpenMeterPlanKey(input.clientId, plan.id);
  const changed = await client.subscriptions.change(primary.id, {
    timing,
    plan: { key: planKey },
  });
  const next = changed?.next;
  if (!next?.id) {
    throw new Error("Failed to change OpenMeter subscription");
  }

  const customerKey = buildOpenMeterCustomerKey(input.clientId, input.externalUserId);
  await upsertLocalSubscriptionCache({
    clientId: input.clientId,
    externalUserId: input.externalUserId,
    planId: plan.id,
    status: next.status ?? "active",
    openmeterSubscriptionId: next.id,
    customerKey,
    cancelledAt: null,
    currentPeriodStart:
      next.activeFrom instanceof Date
        ? next.activeFrom.toISOString()
        : (next.activeFrom as string | undefined) ?? null,
    currentPeriodEnd:
      next.activeTo instanceof Date
        ? next.activeTo.toISOString()
        : (next.activeTo as string | undefined) ?? null,
  });

  return {
    previousSubscriptionId: primary.id,
    subscriptionId: next.id,
    planId: plan.id,
    status: String(next.status ?? "active"),
    timing,
  };
}

export async function migrateEndUserSubscriptionToLatestPlanVersion(input: {
  clientId: string;
  externalUserId: string;
  timing?: SubscriptionTimingMode;
}): Promise<{
  previousSubscriptionId: string;
  subscriptionId: string;
  status: string;
}> {
  const primary = await getPrimaryOpenMeterSubscriptionForAppUser({
    clientId: input.clientId,
    externalUserId: input.externalUserId,
  });
  if (!primary || !isOpenMeterSubscriptionActive(primary.status)) {
    throw new Error("No active subscription found");
  }

  const client = getHostedAdminClient();
  const timing = input.timing ?? "immediate";
  const migrated = await client.subscriptions.migrate(primary.id, { timing });
  const next = migrated?.next;
  if (!next?.id) {
    throw new Error("Failed to migrate OpenMeter subscription");
  }

  const customerKey = buildOpenMeterCustomerKey(input.clientId, input.externalUserId);
  const local = await db
    .select()
    .from(subscriptions)
    .where(
      and(
        eq(subscriptions.clientId, input.clientId),
        eq(subscriptions.externalUserId, input.externalUserId),
      ),
    )
    .limit(1);

  if (local[0]) {
    await upsertLocalSubscriptionCache({
      clientId: input.clientId,
      externalUserId: input.externalUserId,
      planId: local[0].planId,
      status: next.status ?? "active",
      openmeterSubscriptionId: next.id,
      customerKey,
      cancelledAt: null,
    });
  }

  return {
    previousSubscriptionId: primary.id,
    subscriptionId: next.id,
    status: String(next.status ?? "active"),
  };
}

export async function createEndUserStripePortalSession(input: {
  clientId: string;
  externalUserId: string;
  returnUrl?: string;
}): Promise<{ portalUrl: string }> {
  const billingConfig = await getAppBillingConfig(input.clientId);
  if (billingConfig?.stripeConnectStatus !== "connected") {
    throw new Error("Stripe is not connected for this app");
  }

  const client = getHostedAdminClient();
  const customer = await ensureOpenMeterCustomerForAppUser({
    client,
    clientId: input.clientId,
    externalUserId: input.externalUserId,
  });

  const origin = getPublicOrigin();
  const returnUrl =
    input.returnUrl ||
    billingConfig.checkoutSuccessUrl ||
    `${origin}/apps/${input.clientId}/settings?tab=payments`;

  const session = await client.customers.stripe.createPortalSession(customer.id, {
    returnUrl,
  });
  if (!session?.url) {
    throw new Error("Stripe customer portal URL unavailable");
  }
  return { portalUrl: session.url };
}

export async function updateAppCheckoutUrls(input: {
  clientId: string;
  checkoutSuccessUrl?: string | null;
  checkoutCancelUrl?: string | null;
  defaultCurrency?: string;
  taxBehavior?: "inclusive" | "exclusive" | null;
}): Promise<void> {
  const patch: Record<string, unknown> = {};
  if (input.checkoutSuccessUrl !== undefined) {
    patch.checkoutSuccessUrl = input.checkoutSuccessUrl?.trim() || null;
  }
  if (input.checkoutCancelUrl !== undefined) {
    patch.checkoutCancelUrl = input.checkoutCancelUrl?.trim() || null;
  }
  if (input.defaultCurrency !== undefined) {
    const currency = input.defaultCurrency.trim().toUpperCase() || "USD";
    if (currency !== "USD") {
      throw new Error("Only USD is supported as defaultCurrency");
    }
    patch.defaultCurrency = currency;
  }
  if (input.taxBehavior !== undefined) {
    patch.taxBehavior = input.taxBehavior;
  }
  await upsertAppBillingConfig(input.clientId, patch);
}
