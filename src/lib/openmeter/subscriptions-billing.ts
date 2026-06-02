import { and, eq } from "drizzle-orm";
import { v4 as uuidv4 } from "uuid";
import { db } from "@/db/index";
import { plans, subscriptions } from "@/db/schema";
import { getHostedAdminClient } from "./admin-client";
import { applyTenantBillingProfileToCustomer, getAppBillingConfig } from "./billing-profiles";
import { buildOpenMeterCustomerKey } from "./customer-key";
import { ensureOpenMeterCustomerForAppUser } from "./customers";
import { buildOpenMeterPlanKey } from "./plans-sync";
import { getPublicOrigin } from "@/lib/oidc/issuer-urls";

export async function createEndUserCheckout(input: {
  clientId: string;
  externalUserId: string;
  planId: string;
  successUrl?: string;
  cancelUrl?: string;
}): Promise<{ checkoutUrl: string; subscriptionId?: string }> {
  const planRows = await db
    .select()
    .from(plans)
    .where(eq(plans.id, input.planId))
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
        planId: plan.id,
        status: "pending",
        openmeterSubscriptionId: subscription.id,
        openmeterCustomerKey: customerKey,
        externalUserId: input.externalUserId,
        stripeCheckoutSessionId: checkout.sessionId ?? null,
      })
      .where(eq(subscriptions.id, existing[0].id));
  } else {
    await db.insert(subscriptions).values({
      id: uuidv4(),
      userId: null,
      clientId: input.clientId,
      planId: plan.id,
      status: "pending",
      openmeterSubscriptionId: subscription.id,
      openmeterCustomerKey: customerKey,
      externalUserId: input.externalUserId,
      stripeCheckoutSessionId: checkout.sessionId ?? null,
      createdAt: now,
    });
  }

  return { checkoutUrl: checkout.url, subscriptionId: subscription.id };
}
