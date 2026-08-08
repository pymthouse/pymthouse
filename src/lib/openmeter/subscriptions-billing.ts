import { and, eq } from "drizzle-orm";
import { v4 as uuidv4 } from "uuid";
import { db } from "@/db/index";
import { plans, subscriptions } from "@/db/schema";
import { appSettingsAbsoluteUrl } from "@/lib/apps/settings-paths";
import { getPublicOrigin } from "@/lib/oidc/issuer-urls";
import { getOrCreateStarterPlan } from "@/lib/starter-default-plan";
import {
  connectPaymentsOnlyEnabled,
  createMerchantConnectCheckoutForUser,
  isMerchantConnectPaymentsReady,
} from "@/lib/stripe/merchant-connect";
import { getHostedAdminClient } from "./admin-client";
import {
  applyFreeBillingProfileToCustomer,
  applyTenantBillingProfileToCustomer,
  getAppBillingConfig,
  prepareAppCustomerStripeBilling,
} from "./billing-profiles";
import { getHostedOpenMeterUrl } from "./constants";
import { buildOpenMeterCustomerKey } from "./customer-key";
import { ensureOpenMeterCustomerForAppUser } from "./customers";
import {
  cancelKonnectSubscription,
  changeKonnectSubscription,
  deleteKonnectSubscription,
  type SubscriptionChangeTiming,
} from "./konnect-subscriptions";
import { isOwnerStarterPlanKey } from "./owner-starter-key";
import { isOpenMeterConflictError } from "./plan-errors";
import { buildOpenMeterPlanKey } from "./plans-sync";
import { shouldUseKonnectRoutes } from "./route-mode";
import {
  getPrimaryOpenMeterSubscriptionForAppUser,
  listOpenMeterSubscriptionsForCustomer,
  resolveLocalPlanIdFromOpenMeterSubscription,
  type OpenMeterSubscriptionView,
} from "./subscription-read";
import {
  clearScheduledBeforeMutation,
  clearScheduledSubscriptions,
  isKonnectScheduledChangeForbidden,
  isLiveSubscriptionStatus,
  isOccupyingCanceledSubscription,
  isScheduledSubscriptionStatus,
  listScheduledSubscriptionIds,
  pickMutationTargetSubscription,
  pickOccupyingCanceledSubscription,
  reactivateOccupyingCanceledSubscription,
} from "./subscription-state";
import { createOpenMeterStripeCheckoutSession } from "./stripe-checkout-session";
import { getKonnectDefaultPaymentMethodId } from "./stripe-customer-data";

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
  // Pay-per-use has no flat fee, but still needs a card for threshold auto-debit
  // after prepaid credits (issue #398). Collect via setup Checkout on switch.
  if (plan.type.trim().toLowerCase() === "usage") {
    return true;
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

export function shouldApplyFreeBillingProfileForCheckout(input: {
  isMerchantBilling: boolean;
  needsPaymentMethod: boolean;
  defaultPaymentMethodId: string | null;
}): boolean {
  return (
    !input.isMerchantBilling &&
    input.needsPaymentMethod &&
    !input.defaultPaymentMethodId
  );
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

/**
 * Remove a present OpenMeter subscription so Checkout can create the target
 * plan. Scheduled rows must use DELETE — Konnect forbids /cancel on them
 * ("transition cancel in state scheduled not allowed").
 */
async function clearOpenMeterSubscriptionForCheckout(
  subscription: OpenMeterSubscriptionView,
): Promise<void> {
  const subscriptionId = subscription.id.trim();
  if (!subscriptionId) {
    return;
  }
  if (isScheduledSubscriptionStatus(subscription.status)) {
    await deleteKonnectSubscription({ subscriptionId });
    return;
  }
  try {
    await cancelKonnectSubscription({
      subscriptionId,
      timing: "immediate",
    });
    return;
  } catch (cancelErr) {
    console.warn(
      "checkout: immediate cancel failed, trying delete",
      subscriptionId,
      cancelErr instanceof Error ? cancelErr.message : cancelErr,
    );
  }
  await deleteKonnectSubscription({ subscriptionId });
}

async function checkoutViaReactivatedCanceledSubscription(input: {
  client: ReturnType<typeof getHostedAdminClient>;
  checkoutInput: EndUserCheckoutInput;
  customerId: string;
  occupying: OpenMeterSubscriptionView;
  planId: string;
  needsPaymentMethod: boolean;
  defaultPaymentMethodId: string | null;
  successUrl: string;
}): Promise<CheckoutSubscriptionResult> {
  await reactivateOccupyingCanceledSubscription(input.occupying.id.trim());

  const live = await getPrimaryOpenMeterSubscriptionForAppUser({
    clientId: input.checkoutInput.clientId,
    externalUserId: input.checkoutInput.externalUserId,
  });
  if (!live || !isLiveSubscriptionStatus(live.status)) {
    throw new Error(
      "Could not resume the existing subscription before switching plans",
    );
  }

  const liveLocalPlanId = await resolveLocalPlanIdFromOpenMeterSubscription(
    input.checkoutInput.clientId,
    live,
  );
  if (liveLocalPlanId === input.planId) {
    return { subscriptionId: live.id.trim() };
  }

  if (input.needsPaymentMethod && !input.defaultPaymentMethodId) {
    await clearOpenMeterSubscriptionForCheckout(live);
    const created = await input.client.subscriptions.create({
      customerId: input.customerId,
      plan: {
        key: buildOpenMeterPlanKey(input.checkoutInput.clientId, input.planId),
      },
    });
    return { subscriptionId: created?.id?.trim() || "" };
  }

  return {
    checkout: await checkoutAfterPlanChange(
      input.checkoutInput,
      input.successUrl,
    ),
  };
}

/**
 * Drop every scheduled/pending successor for this customer so
 * `subscriptions.create` cannot 409 on an orphaned scheduled row.
 */
async function clearScheduledSubscriptionsForCustomer(input: {
  client: ReturnType<typeof getHostedAdminClient>;
  customerId: string;
}): Promise<void> {
  const listed = await listOpenMeterSubscriptionsForCustomer(
    input.client,
    input.customerId,
  );
  const scheduledIds = listScheduledSubscriptionIds(listed);
  if (scheduledIds.length === 0) {
    return;
  }
  await clearScheduledSubscriptions(scheduledIds);
}

async function checkoutAfterPlanChange(
  input: EndUserCheckoutInput,
  fallbackSuccessUrl: string,
): Promise<CheckoutResult> {
  const changed = await changeAppUserSubscriptionPlan(input);
  const checkoutUrl =
    changed.checkoutUrl?.trim() || fallbackSuccessUrl.trim();
  if (!checkoutUrl) {
    throw new Error(
      "Plan change succeeded but no Checkout or success URL is available",
    );
  }
  return {
    checkoutUrl,
    ...(changed.subscriptionId
      ? { subscriptionId: changed.subscriptionId }
      : {}),
  };
}

type EndUserCheckoutInput = {
  clientId: string;
  externalUserId: string;
  planId: string;
  successUrl?: string;
  cancelUrl?: string;
};

type CheckoutResult = {
  checkoutUrl: string;
  subscriptionId?: string;
};

type CheckoutSubscriptionResult =
  | { checkout: CheckoutResult }
  | { subscriptionId: string };

async function resolveCheckoutSettings(input: EndUserCheckoutInput): Promise<{
  merchantReady: boolean;
  isMerchantBilling: boolean;
  successUrl: string;
  cancelUrl: string;
}> {
  const billingConfig = await getAppBillingConfig(input.clientId);
  const merchantReady = isMerchantConnectPaymentsReady(billingConfig);
  if (!merchantReady && connectPaymentsOnlyEnabled(billingConfig)) {
    throw new Error(
      "Merchant Stripe Connect onboarding is required before checkout (connectPaymentsOnly)",
    );
  }

  const origin = getPublicOrigin();
  const fallbackUrl = appSettingsAbsoluteUrl(origin, input.clientId, "payments");
  return {
    merchantReady,
    isMerchantBilling: billingConfig?.billingMode === "merchant",
    successUrl:
      input.successUrl || billingConfig?.checkoutSuccessUrl || fallbackUrl,
    cancelUrl:
      input.cancelUrl || billingConfig?.checkoutCancelUrl || fallbackUrl,
  };
}

async function applyCheckoutBillingProfile(input: {
  client: ReturnType<typeof getHostedAdminClient>;
  clientId: string;
  customerId: string;
  customerKey: string;
  isMerchantBilling: boolean;
  needsPaymentMethod: boolean;
  defaultPaymentMethodId: string | null;
}): Promise<void> {
  if (
    shouldApplyFreeBillingProfileForCheckout({
      isMerchantBilling: input.isMerchantBilling,
      needsPaymentMethod: input.needsPaymentMethod,
      defaultPaymentMethodId: input.defaultPaymentMethodId,
    })
  ) {
    await applyFreeBillingProfileToCustomer({
      client: input.client,
      customerId: input.customerId,
    });
    return;
  }
  await applyTenantBillingProfileToCustomer({
    client: input.client,
    clientId: input.clientId,
    customerId: input.customerId,
    customerKey: input.customerKey,
  });
}

async function resolveExistingCheckoutSubscription(input: {
  client: ReturnType<typeof getHostedAdminClient>;
  checkoutInput: EndUserCheckoutInput;
  customerId: string;
  planId: string;
  needsPaymentMethod: boolean;
  defaultPaymentMethodId: string | null;
  successUrl: string;
}): Promise<CheckoutSubscriptionResult | null> {
  const existing = await getPrimaryOpenMeterSubscriptionForAppUser({
    clientId: input.checkoutInput.clientId,
    externalUserId: input.checkoutInput.externalUserId,
  });
  if (!existing) {
    return null;
  }

  // Cancel-at-period-end still blocks create — restore then /change.
  if (isOccupyingCanceledSubscription(existing)) {
    return checkoutViaReactivatedCanceledSubscription({
      client: input.client,
      checkoutInput: input.checkoutInput,
      customerId: input.customerId,
      occupying: existing,
      planId: input.planId,
      needsPaymentMethod: input.needsPaymentMethod,
      defaultPaymentMethodId: input.defaultPaymentMethodId,
      successUrl: input.successUrl,
    });
  }

  const existingLocalPlanId = await resolveLocalPlanIdFromOpenMeterSubscription(
    input.checkoutInput.clientId,
    existing,
  );

  // Same plan already present (live or scheduled) — reuse for Checkout session.
  if (existingLocalPlanId === input.planId && existing.id.trim()) {
    return { subscriptionId: existing.id.trim() };
  }

  // Scheduled-only (or scheduled successor of another plan): DELETE then create.
  // Never route these through /change — Konnect 403s, and create 409s if left.
  if (isScheduledSubscriptionStatus(existing.status)) {
    await clearOpenMeterSubscriptionForCheckout(existing);
    return null;
  }

  // Live sub, no card yet — clear and create target for Checkout to collect PM.
  if (input.needsPaymentMethod && !input.defaultPaymentMethodId) {
    await clearOpenMeterSubscriptionForCheckout(existing);
    return null;
  }

  // Live sub + card: switch via /change (may still return a Checkout URL).
  return {
    checkout: await checkoutAfterPlanChange(input.checkoutInput, input.successUrl),
  };
}

async function createCheckoutSubscriptionAfterConflict(input: {
  client: ReturnType<typeof getHostedAdminClient>;
  checkoutInput: EndUserCheckoutInput;
  customerId: string;
  planId: string;
  planKey: string;
  needsPaymentMethod: boolean;
  defaultPaymentMethodId: string | null;
  successUrl: string;
}): Promise<CheckoutSubscriptionResult> {
  let conflictError: unknown;
  try {
    const subscription = await input.client.subscriptions.create({
      customerId: input.customerId,
      plan: { key: input.planKey },
    });
    return { subscriptionId: subscription?.id?.trim() || "" };
  } catch (err) {
    if (!isOpenMeterConflictError(err)) {
      throw err;
    }
    conflictError = err;
  }

  // Orphaned scheduled rows commonly cause create 409 — clear then retry create.
  await clearScheduledSubscriptionsForCustomer({
    client: input.client,
    customerId: input.customerId,
  });

  const listed = await listOpenMeterSubscriptionsForCustomer(
    input.client,
    input.customerId,
  );
  const occupyingCanceled = pickOccupyingCanceledSubscription(listed);
  if (occupyingCanceled) {
    return checkoutViaReactivatedCanceledSubscription({
      client: input.client,
      checkoutInput: input.checkoutInput,
      customerId: input.customerId,
      occupying: occupyingCanceled,
      planId: input.planId,
      needsPaymentMethod: input.needsPaymentMethod,
      defaultPaymentMethodId: input.defaultPaymentMethodId,
      successUrl: input.successUrl,
    });
  }

  const raced = await getPrimaryOpenMeterSubscriptionForAppUser({
    clientId: input.checkoutInput.clientId,
    externalUserId: input.checkoutInput.externalUserId,
  });

  if (!raced) {
    try {
      const created = await input.client.subscriptions.create({
        customerId: input.customerId,
        plan: { key: input.planKey },
      });
      return { subscriptionId: created?.id?.trim() || "" };
    } catch (retryErr) {
      if (isOpenMeterConflictError(retryErr)) {
        throw conflictError;
      }
      throw retryErr;
    }
  }

  if (isOccupyingCanceledSubscription(raced)) {
    return checkoutViaReactivatedCanceledSubscription({
      client: input.client,
      checkoutInput: input.checkoutInput,
      customerId: input.customerId,
      occupying: raced,
      planId: input.planId,
      needsPaymentMethod: input.needsPaymentMethod,
      defaultPaymentMethodId: input.defaultPaymentMethodId,
      successUrl: input.successUrl,
    });
  }

  const racedLocalPlanId = await resolveLocalPlanIdFromOpenMeterSubscription(
    input.checkoutInput.clientId,
    raced,
  );
  if (racedLocalPlanId === input.planId) {
    return { subscriptionId: raced.id };
  }

  // Still scheduled after clear attempt — force DELETE and create.
  if (isScheduledSubscriptionStatus(raced.status)) {
    await clearOpenMeterSubscriptionForCheckout(raced);
    const created = await input.client.subscriptions.create({
      customerId: input.customerId,
      plan: { key: input.planKey },
    });
    return { subscriptionId: created?.id?.trim() || "" };
  }

  // Live different plan with a card: switch via /change.
  if (!input.needsPaymentMethod || input.defaultPaymentMethodId) {
    return {
      checkout: await checkoutAfterPlanChange(
        input.checkoutInput,
        input.successUrl,
      ),
    };
  }

  await clearOpenMeterSubscriptionForCheckout(raced);
  const created = await input.client.subscriptions.create({
    customerId: input.customerId,
    plan: { key: input.planKey },
  });
  return { subscriptionId: created?.id?.trim() || "" };
}

async function getOrCreateCheckoutSubscription(input: {
  client: ReturnType<typeof getHostedAdminClient>;
  checkoutInput: EndUserCheckoutInput;
  customerId: string;
  planId: string;
  needsPaymentMethod: boolean;
  defaultPaymentMethodId: string | null;
  successUrl: string;
}): Promise<CheckoutSubscriptionResult> {
  const existing = await resolveExistingCheckoutSubscription({
    client: input.client,
    checkoutInput: input.checkoutInput,
    customerId: input.customerId,
    planId: input.planId,
    needsPaymentMethod: input.needsPaymentMethod,
    defaultPaymentMethodId: input.defaultPaymentMethodId,
    successUrl: input.successUrl,
  });
  if (existing) {
    return existing;
  }
  // Avoid create 409 from orphaned scheduled rows (DELETE, not /change).
  await clearScheduledSubscriptionsForCustomer({
    client: input.client,
    customerId: input.customerId,
  });
  // Cancel-at-period-end (incl. Starter) is invisible to "live" helpers but
  // still blocks create — restore before the create attempt.
  const preCreateListed = await listOpenMeterSubscriptionsForCustomer(
    input.client,
    input.customerId,
  );
  const occupyingCanceled = pickOccupyingCanceledSubscription(preCreateListed);
  if (occupyingCanceled) {
    return checkoutViaReactivatedCanceledSubscription({
      client: input.client,
      checkoutInput: input.checkoutInput,
      customerId: input.customerId,
      occupying: occupyingCanceled,
      planId: input.planId,
      needsPaymentMethod: input.needsPaymentMethod,
      defaultPaymentMethodId: input.defaultPaymentMethodId,
      successUrl: input.successUrl,
    });
  }
  return createCheckoutSubscriptionAfterConflict({
    client: input.client,
    checkoutInput: input.checkoutInput,
    customerId: input.customerId,
    planId: input.planId,
    planKey: buildOpenMeterPlanKey(input.checkoutInput.clientId, input.planId),
    needsPaymentMethod: input.needsPaymentMethod,
    defaultPaymentMethodId: input.defaultPaymentMethodId,
    successUrl: input.successUrl,
  });
}

async function createCheckoutSession(input: {
  merchantReady: boolean;
  checkoutInput: EndUserCheckoutInput;
  client: ReturnType<typeof getHostedAdminClient>;
  customerId: string;
  customerKey: string;
  successUrl: string;
  cancelUrl: string;
}): Promise<{ checkoutUrl: string; sessionId: string | null }> {
  if (input.merchantReady) {
    const checkout = await createMerchantConnectCheckoutForUser({
      clientId: input.checkoutInput.clientId,
      externalUserId: input.checkoutInput.externalUserId,
      successUrl: input.successUrl,
      cancelUrl: input.cancelUrl,
      openmeterCustomerId: input.customerId,
      openmeterCustomerKey: input.customerKey,
    });
    return {
      checkoutUrl: checkout.checkoutUrl,
      sessionId: checkout.sessionId,
    };
  }
  const checkout = await createOpenMeterStripeCheckoutSession({
    client: input.client,
    customerId: input.customerId,
    successUrl: input.successUrl,
    cancelUrl: input.cancelUrl,
  });
  return {
    checkoutUrl: checkout.checkoutUrl,
    sessionId: checkout.sessionId,
  };
}

export async function createEndUserCheckout(
  input: EndUserCheckoutInput,
): Promise<CheckoutResult> {
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

  const checkoutSettings = await resolveCheckoutSettings(input);

  const needsPaymentMethod = planRequiresPaymentMethod(plan);
  const defaultPaymentMethodId = needsPaymentMethod
    ? await getKonnectDefaultPaymentMethodId(customer.id)
    : null;
  await applyCheckoutBillingProfile({
    client,
    clientId: input.clientId,
    customerId: customer.id,
    customerKey: customer.key,
    isMerchantBilling: checkoutSettings.isMerchantBilling,
    needsPaymentMethod,
    defaultPaymentMethodId,
  });

  const subscription = await getOrCreateCheckoutSubscription({
    client,
    checkoutInput: input,
    customerId: customer.id,
    planId: plan.id,
    needsPaymentMethod,
    defaultPaymentMethodId,
    successUrl: checkoutSettings.successUrl,
  });
  if ("checkout" in subscription) {
    return subscription.checkout;
  }
  if (!subscription.subscriptionId) {
    throw new Error("Failed to create OpenMeter subscription");
  }

  const checkout = await createCheckoutSession({
    merchantReady: checkoutSettings.merchantReady,
    checkoutInput: input,
    client,
    customerId: customer.id,
    customerKey: customer.key,
    successUrl: checkoutSettings.successUrl,
    cancelUrl: checkoutSettings.cancelUrl,
  });

  await upsertNeonSubscriptionCache({
    clientId: input.clientId,
    externalUserId: input.externalUserId,
    planId: plan.id,
    openmeterSubscriptionId: subscription.subscriptionId,
    status: "pending",
    stripeCheckoutSessionId: checkout.sessionId,
  });

  return {
    checkoutUrl: checkout.checkoutUrl,
    subscriptionId: subscription.subscriptionId,
  };
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
 * Clears scheduled successors before `/change` (same state machine as owner
 * paid upgrade) so Konnect never sees "transition cancel in state scheduled".
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

  const starter = await getOrCreateStarterPlan(input.clientId);
  const starterPlanKey = buildOpenMeterPlanKey(input.clientId, starter.id);
  const starterOpenMeterPlanId = starter.openmeterPlanId?.trim() || null;
  const isStarter = (sub: OpenMeterSubscriptionView) => {
    if (isOwnerStarterPlanKey(sub.planKey)) return true;
    if (sub.planKey && sub.planKey === starterPlanKey) return true;
    if (starterOpenMeterPlanId && sub.planId === starterOpenMeterPlanId) {
      return true;
    }
    return false;
  };

  let listed = await listOpenMeterSubscriptionsForCustomer(
    client,
    customer.id,
  );
  let scheduledIds = listScheduledSubscriptionIds(listed);
  let current = pickMutationTargetSubscription(listed, isStarter);

  // Clear scheduled successors so `/change` targets a live row only.
  // Never call `/change` on a scheduled id (Konnect 403).
  if (scheduledIds.length > 0) {
    const canceledPaid = listed.find(
      (s) =>
        Boolean(s.id) &&
        (s.status || "").toLowerCase() === "canceled" &&
        !isStarter(s),
    );
    await clearScheduledBeforeMutation({
      scheduledIds,
      canceledPaidId: current ? null : (canceledPaid?.id ?? null),
    });
    listed = await listOpenMeterSubscriptionsForCustomer(client, customer.id);
    scheduledIds = listScheduledSubscriptionIds(listed);
    current = pickMutationTargetSubscription(listed, isStarter);

    if (!current && scheduledIds.length > 0) {
      throw new Error(
        "A scheduled plan change is blocking this switch and cannot be removed automatically. Contact support.",
      );
    }
  }

  if (!current) {
    // No live subscription (including after deleting a scheduled-only plan) → Checkout.
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

  if (!isLiveSubscriptionStatus(current.status)) {
    throw new Error(
      "A scheduled plan change is blocking this switch and cannot be removed automatically. Contact support.",
    );
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

  const timing =
    input.timing ??
    defaultSubscriptionChangeTiming({
      currentPriceAmount: currentLocalPlan?.priceAmount,
      targetPriceAmount: targetPlan.priceAmount,
    });

  let change;
  try {
    change = await changeKonnectSubscription({
      subscriptionId: current.id,
      customerId: customer.id,
      planId: targetPlan.openmeterPlanId!,
      timing,
    });
  } catch (err) {
    if (!isKonnectScheduledChangeForbidden(err)) {
      throw err;
    }
    // Race: a scheduled successor appeared; clear and fall back to checkout.
    const retryListed = await listOpenMeterSubscriptionsForCustomer(
      client,
      customer.id,
    );
    await clearScheduledBeforeMutation({
      scheduledIds: listScheduledSubscriptionIds(retryListed),
      canceledPaidId: null,
    });
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

  const nextSubscriptionId =
    change.next?.id?.trim() ||
    change.current?.id?.trim() ||
    current.id;
  const effectiveAt = new Date().toISOString();

  let checkoutUrl: string | undefined;
  let stripeCheckoutSessionId: string | null | undefined;

  if (planRequiresPaymentMethod(targetPlan)) {
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
        openmeterCustomerId: customer.id,
        openmeterCustomerKey: customer.key,
      });
      checkoutUrl = connectCheckout.checkoutUrl;
      stripeCheckoutSessionId = connectCheckout.sessionId;
    } else {
      const paymentMethodId = await getKonnectDefaultPaymentMethodId(customer.id);
      if (!paymentMethodId) {
        if (connectPaymentsOnlyEnabled(billingConfig)) {
          throw new Error(
            "Merchant Stripe Connect onboarding is required before checkout (connectPaymentsOnly)",
          );
        }
        const checkout = await createOpenMeterStripeCheckoutSession({
          client,
          customerId: customer.id,
          successUrl: success,
          cancelUrl: cancel,
        });
        checkoutUrl = checkout.checkoutUrl;
        stripeCheckoutSessionId = checkout.sessionId;
      }
    }
  }

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
