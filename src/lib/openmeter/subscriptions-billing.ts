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
import { assertAppUserRetailBillingSubject } from "./billing-identity";
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
import {
  recordAppUserPaymentMethodCheckout,
  resolveAppUserCheckoutReturnUrl,
  resolveAppUserDefaultPaymentMethodId,
} from "@/lib/openmeter/app-user-payment-method";
import { createOpenMeterStripeCheckoutSession } from "./stripe-checkout-session";
import { getKonnectDefaultPaymentMethodId } from "./stripe-customer-data";

/**
 * Merchant Connect: Stripe invoice default on the connected customer.
 * Platform / Konnect: Konnect default_payment_method pointer.
 */
async function resolveCheckoutDefaultPaymentMethodId(input: {
  clientId: string;
  externalUserId: string;
  openMeterCustomerId: string;
  merchantReady: boolean;
}): Promise<string | null> {
  if (input.merchantReady) {
    return resolveAppUserDefaultPaymentMethodId({
      clientId: input.clientId,
      externalUserId: input.externalUserId,
    });
  }
  return getKonnectDefaultPaymentMethodId(input.openMeterCustomerId);
}

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

function planIsFreeOrStarter(input: {
  priceAmount: string | null | undefined;
  type?: string | null;
  isStarterDefault?: boolean | null;
}): boolean {
  if (input.isStarterDefault) return true;
  const type = (input.type ?? "").trim().toLowerCase();
  if (type === "free") return true;
  return parsePlanPriceAmount(input.priceAmount) <= 0 && type !== "usage";
}

/**
 * When to apply a plan change on Konnect.
 *
 * - Paid upgrades (target price > current) → immediate
 * - Free / Starter → usage (PPU) → immediate so included usage ends now
 * - Paid downgrades / same-price moves → next_billing_cycle
 */
export function defaultSubscriptionChangeTiming(input: {
  currentPriceAmount: string | null | undefined;
  targetPriceAmount: string;
  currentPlanType?: string | null;
  targetPlanType?: string | null;
  currentIsStarterDefault?: boolean | null;
}): SubscriptionChangeTiming {
  const current = parsePlanPriceAmount(input.currentPriceAmount);
  const target = parsePlanPriceAmount(input.targetPriceAmount);
  if (target > current) {
    return "immediate";
  }
  const targetType = (input.targetPlanType ?? "").trim().toLowerCase();
  const leavingFreeOrStarter = planIsFreeOrStarter({
    priceAmount: input.currentPriceAmount,
    type: input.currentPlanType,
    isStarterDefault: input.currentIsStarterDefault,
  });
  if (leavingFreeOrStarter && targetType === "usage") {
    return "immediate";
  }
  return "next_billing_cycle";
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

/**
 * Paid / pay-per-use targets need a card on file before Konnect will accept the
 * subscription change. Defer `/change` until setup Checkout completes.
 */
export function shouldCollectPaymentMethodBeforePlanChange(input: {
  targetRequiresPaymentMethod: boolean;
  hasDefaultPaymentMethod: boolean;
}): boolean {
  return input.targetRequiresPaymentMethod && !input.hasDefaultPaymentMethod;
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
    throw new Error(
      "Cannot switch plans without a default payment method; collect a card first",
    );
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
    successUrl: resolveAppUserCheckoutReturnUrl(
      input.successUrl || billingConfig?.checkoutSuccessUrl || undefined,
      fallbackUrl,
    ),
    cancelUrl: resolveAppUserCheckoutReturnUrl(
      input.cancelUrl || billingConfig?.checkoutCancelUrl || undefined,
      fallbackUrl,
    ),
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

  // Live sub without a card: never clear-and-create — that left users on the
  // target plan after Checkout cancel. Collect PM first (caller early-returns).
  if (input.needsPaymentMethod && !input.defaultPaymentMethodId) {
    throw new Error(
      "Cannot switch plans without a default payment method; collect a card first",
    );
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

  throw new Error(
    "Cannot switch plans without a default payment method; collect a card first",
  );
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

/**
 * Setup-mode Checkout when a plan switch needs a card that is not on file yet.
 * Returns null when Checkout is not required (plan is free, or a default PM
 * already exists). Must run before Konnect `/change` — Stripe-backed profiles
 * reject the switch without a default payment method.
 *
 * Exported for unit tests that exercise the PM-before-/change gate.
 */
export async function createPaymentMethodCheckoutIfNeededForPlanChange(input: {
  clientId: string;
  externalUserId: string;
  customerId: string;
  customerKey: string;
  targetPlan: {
    id: string;
    type: string;
    priceAmount: string;
    isStarterDefault?: boolean | null;
    isNetworkDefault?: boolean | null;
  };
  client: ReturnType<typeof getHostedAdminClient>;
  successUrl?: string;
  cancelUrl?: string;
}): Promise<{ checkoutUrl: string; sessionId: string | null } | null> {
  if (!planRequiresPaymentMethod(input.targetPlan)) {
    return null;
  }

  const billingConfig = await getAppBillingConfig(input.clientId);
  const merchantReady = isMerchantConnectPaymentsReady(billingConfig);
  const defaultPaymentMethodId = await resolveCheckoutDefaultPaymentMethodId({
    clientId: input.clientId,
    externalUserId: input.externalUserId,
    openMeterCustomerId: input.customerId,
    merchantReady,
  });
  if (
    !shouldCollectPaymentMethodBeforePlanChange({
      targetRequiresPaymentMethod: true,
      hasDefaultPaymentMethod: Boolean(defaultPaymentMethodId),
    })
  ) {
    return null;
  }

  if (!merchantReady && connectPaymentsOnlyEnabled(billingConfig)) {
    throw new Error(
      "Merchant Stripe Connect onboarding is required before checkout (connectPaymentsOnly)",
    );
  }

  const origin = getPublicOrigin();
  const fallbackUrl = appSettingsAbsoluteUrl(origin, input.clientId, "payments");
  const success = resolveAppUserCheckoutReturnUrl(
    input.successUrl || billingConfig?.checkoutSuccessUrl || undefined,
    fallbackUrl,
  );
  const cancel = resolveAppUserCheckoutReturnUrl(
    input.cancelUrl || billingConfig?.checkoutCancelUrl || undefined,
    fallbackUrl,
  );

  const checkout = await createCheckoutSession({
    merchantReady,
    checkoutInput: {
      clientId: input.clientId,
      externalUserId: input.externalUserId,
      planId: input.targetPlan.id,
    },
    client: input.client,
    customerId: input.customerId,
    customerKey: input.customerKey,
    successUrl: success,
    cancelUrl: cancel,
  });
  await recordAppUserPaymentMethodCheckout({
    sessionId: checkout.sessionId,
    clientId: input.clientId,
    externalUserId: input.externalUserId,
  });
  return checkout;
}

export async function createEndUserCheckout(
  input: EndUserCheckoutInput,
): Promise<CheckoutResult> {
  await assertAppUserRetailBillingSubject({
    clientId: input.clientId,
    externalUserId: input.externalUserId,
  });

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
    ? await resolveCheckoutDefaultPaymentMethodId({
        clientId: input.clientId,
        externalUserId: input.externalUserId,
        openMeterCustomerId: customer.id,
        merchantReady: checkoutSettings.merchantReady,
      })
    : null;

  // Never create/switch the OpenMeter subscription before a required card is
  // on file. Applying the free billing profile + create left users on the
  // target plan after Checkout cancel.
  if (
    shouldCollectPaymentMethodBeforePlanChange({
      targetRequiresPaymentMethod: needsPaymentMethod,
      hasDefaultPaymentMethod: Boolean(defaultPaymentMethodId),
    })
  ) {
    const checkout = await createCheckoutSession({
      merchantReady: checkoutSettings.merchantReady,
      checkoutInput: input,
      client,
      customerId: customer.id,
      customerKey: customer.key,
      successUrl: checkoutSettings.successUrl,
      cancelUrl: checkoutSettings.cancelUrl,
    });
    await recordAppUserPaymentMethodCheckout({
      sessionId: checkout.sessionId,
      clientId: input.clientId,
      externalUserId: input.externalUserId,
    });
    return { checkoutUrl: checkout.checkoutUrl };
  }

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

  // Card already on file — subscription is live; no setup Checkout needed.
  await upsertNeonSubscriptionCache({
    clientId: input.clientId,
    externalUserId: input.externalUserId,
    planId: plan.id,
    openmeterSubscriptionId: subscription.subscriptionId,
    status: "active",
  });

  return {
    checkoutUrl: checkoutSettings.successUrl,
    subscriptionId: subscription.subscriptionId,
  };
}

export type ChangeAppUserSubscriptionPlanResult = {
  subscriptionId: string;
  planId: string;
  effectiveAt: string | null;
  timing: SubscriptionChangeTiming;
  checkoutUrl?: string;
  /** Present when the target plan is scheduled for a future cycle. */
  pendingPlan?: {
    planId: string;
    openmeterSubscriptionId: string;
    effectiveAt: string | null;
  };
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
  await assertAppUserRetailBillingSubject({
    clientId: input.clientId,
    externalUserId: input.externalUserId,
  });

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

  // Cancel-at-period-end still occupies the slot but is not "live". Resume it
  // before /change so Starter→PPU (and similar) can run with immediate timing
  // instead of bouncing to Checkout or leaving a scheduled successor.
  if (!current) {
    const occupying = pickOccupyingCanceledSubscription(listed);
    if (occupying?.id) {
      await reactivateOccupyingCanceledSubscription(occupying.id);
      listed = await listOpenMeterSubscriptionsForCustomer(client, customer.id);
      current = pickMutationTargetSubscription(listed, isStarter);
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
      currentPlanType: currentLocalPlan?.type,
      targetPlanType: targetPlan.type,
      currentIsStarterDefault: currentLocalPlan?.isStarterDefault,
    });

  // Collect a card first when the target needs one. Konnect rejects Stripe-
  // profile /change without a default payment method — returning Checkout
  // after a failed change never reaches the client.
  const paymentMethodCheckout =
    await createPaymentMethodCheckoutIfNeededForPlanChange({
      clientId: input.clientId,
      externalUserId: input.externalUserId,
      customerId: customer.id,
      customerKey: customer.key,
      targetPlan,
      client,
      successUrl: input.successUrl,
      cancelUrl: input.cancelUrl,
    });
  if (paymentMethodCheckout) {
    return {
      subscriptionId: current.id,
      // Still on the current plan — /change has not run yet. Never report the
      // unpaid target when the local plan row failed to load.
      planId: currentLocalPlanId ?? "",
      effectiveAt: null,
      timing,
      checkoutUrl: paymentMethodCheckout.checkoutUrl,
    };
  }

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

  // Neon must track the *live* OM subscription / plan. On next_billing_cycle the
  // successor is scheduled only — keep caching the current live row.
  const liveSubscriptionId =
    change.current?.id?.trim() || current.id;
  const nextSubscriptionId =
    timing === "immediate"
      ? change.next?.id?.trim() || liveSubscriptionId
      : liveSubscriptionId;
  const neonPlanId =
    timing === "immediate"
      ? targetPlan.id
      : (currentLocalPlan?.id ?? targetPlan.id);
  const effectiveAt = new Date().toISOString();

  await upsertNeonSubscriptionCache({
    clientId: input.clientId,
    externalUserId: input.externalUserId,
    planId: neonPlanId,
    openmeterSubscriptionId: nextSubscriptionId,
    status: "active",
  });

  return {
    subscriptionId: nextSubscriptionId,
    planId: timing === "immediate" ? targetPlan.id : neonPlanId,
    effectiveAt,
    timing,
    ...(timing === "next_billing_cycle" && change.next?.id
      ? {
          pendingPlan: {
            planId: targetPlan.id,
            openmeterSubscriptionId: change.next.id.trim(),
            effectiveAt: change.next.activeFrom
              ? String(change.next.activeFrom)
              : null,
          },
        }
      : {}),
  };
}
