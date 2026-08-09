import { eq } from "drizzle-orm";
import { db } from "@/db/index";
import {
  appUserPaymentMethodCheckouts,
  subscriptions,
} from "@/db/schema";
import { appSettingsAbsoluteUrl } from "@/lib/apps/settings-paths";
import { getPublicOrigin } from "@/lib/oidc/issuer-urls";
import { sanitizeForLog } from "@/lib/sanitize-for-log";
import {
  getHostedAdminClient,
  isHostedAdminClientAvailable,
} from "./admin-client";
import {
  getAppBillingConfig,
  prepareAppCustomerStripeBilling,
} from "./billing-profiles";
import { buildOpenMeterCustomerKey } from "./customer-key";
import {
  ensureOpenMeterCustomer,
  findOpenMeterCustomerByKey,
} from "./customers";
import { resolveOpenMeterMeterClientId } from "./meter-client-id";
import {
  buildOwnerPaymentMethodList,
  OWNER_PAYMENT_METHOD_BUDGET_MS,
  setStripeCustomerDefaultPaymentMethod,
  type OwnerPaymentMethodListItem,
  unlinkStripeCustomerPaymentMethod,
} from "./owner-payment-method";
import {
  connectPaymentsOnlyEnabled,
  createMerchantConnectCheckoutForUser,
  getAppUserStripeCustomer,
  isMerchantConnectPaymentsReady,
} from "@/lib/stripe/merchant-connect";
import { createOpenMeterStripeCheckoutSession } from "./stripe-checkout-session";
import {
  clearKonnectStripeDefaultPaymentMethod,
  getKonnectStripeBillingRefs,
  getStripeCustomerAppDataId,
  setKonnectStripeDefaultPaymentMethod,
} from "./stripe-customer-data";

export type AppUserPaymentMethodListItem = OwnerPaymentMethodListItem;

export type AppUserPaymentMethodCheckoutResult = {
  checkoutUrl: string;
  sessionId: string | null;
  customerId: string;
  hasDefaultPaymentMethod: boolean;
};

export type AppUserPaymentMethodRestoreTarget = {
  clientId: string;
  externalUserId: string;
  paymentMethodId?: string | null;
};

/** Persist Checkout session → app-user mapping for webhook restore without metadata. */
export async function recordAppUserPaymentMethodCheckout(input: {
  sessionId: string | null;
  clientId: string;
  externalUserId: string;
}): Promise<void> {
  if (!input.sessionId) {
    return;
  }
  await db
    .insert(appUserPaymentMethodCheckouts)
    .values({
      stripeCheckoutSessionId: input.sessionId,
      clientId: input.clientId,
      externalUserId: input.externalUserId,
    })
    .onConflictDoNothing();
}

/**
 * Restore the billing profile after Stripe has attached a payment method.
 * Uses the compound `{publicClientId}:{externalUserId}` customer — never the
 * owner-wallet path — matching {@link createAppUserPaymentMethodCheckout}.
 * Reassigning the mode-correct profile is safe for webhook retries.
 *
 * When a `paymentMethodId` is known (or the first attached method), promote it
 * to the Stripe/Konnect default so charge_automatically and overage gates work.
 */
export async function restoreAppUserBillingProfileAfterPaymentMethodAttached(
  input: AppUserPaymentMethodRestoreTarget,
): Promise<void> {
  const client = getHostedAdminClient();
  const publicClientId = await resolveOpenMeterMeterClientId(input.clientId);
  const customerKey = buildOpenMeterCustomerKey(
    publicClientId,
    input.externalUserId,
  );
  const customer = await ensureOpenMeterCustomer(client, customerKey);
  await prepareAppCustomerStripeBilling({
    client,
    clientId: input.clientId,
    customerId: customer.id,
    customerKey: customer.key,
  });
  await ensureAppUserDefaultPaymentMethodAfterAttach({
    clientId: input.clientId,
    externalUserId: input.externalUserId,
    paymentMethodId: input.paymentMethodId,
  });
}

/**
 * Promote a just-attached PM to the Stripe invoice default (and Konnect
 * pointer when available) when the customer has no default yet.
 * Failures throw so Stripe webhooks return 500 and retry.
 */
export async function ensureAppUserDefaultPaymentMethodAfterAttach(input: {
  clientId: string;
  externalUserId: string;
  paymentMethodId?: string | null;
}): Promise<void> {
  const chargeable = await appUserHasChargeablePaymentMethod(input);
  if (chargeable === true) {
    return;
  }
  if (chargeable === null) {
    throw new Error("billing payment method lookup failed");
  }
  let paymentMethodId = input.paymentMethodId?.trim() || null;
  if (!paymentMethodId) {
    const refs = await resolveAppUserStripeRefs(input);
    if (!refs) {
      throw new Error("app user Stripe customer not found for default promotion");
    }
    const signal = AbortSignal.timeout(OWNER_PAYMENT_METHOD_BUDGET_MS);
    const { items } = await buildOwnerPaymentMethodList({
      stripeCustomerId: refs.stripeCustomerId,
      konnectDefaultPaymentMethodId: refs.konnectDefaultPaymentMethodId,
      deps: {
        fetchImpl: fetch,
        signal,
        stripeAccount: refs.stripeAccount,
      },
    });
    // Stripe lists newest first; use the newest attached method.
    paymentMethodId = items[0]?.id?.trim() || null;
  }
  if (!paymentMethodId) {
    throw new Error("no payment method available to promote as default");
  }
  const result = await setAppUserDefaultPaymentMethod({
    clientId: input.clientId,
    externalUserId: input.externalUserId,
    paymentMethodId,
  });
  if (!result.updated) {
    throw new Error("failed to set Stripe invoice default payment method");
  }
  const verified = await appUserHasChargeablePaymentMethod(input);
  if (verified !== true) {
    throw new Error(
      "Stripe invoice default payment method not chargeable after promote",
    );
  }
}

/**
 * After setup Checkout return, call PATCH `{ ensureDefault: true }` from the
 * client to promote the first attached payment method when none is default yet.
 * Covers lag / missed Connect webhook deliveries (mirrors owner wallet).
 */
export async function ensureAppUserDefaultPaymentMethodIfMissing(input: {
  clientId: string;
  externalUserId: string;
}): Promise<{ promoted: boolean; paymentMethodId: string | null }> {
  const chargeable = await appUserHasChargeablePaymentMethod(input);
  if (chargeable === true) {
    return { promoted: false, paymentMethodId: null };
  }
  if (chargeable === null) {
    throw new Error("billing payment method lookup failed");
  }
  const methods = await listAppUserPaymentMethods(input);
  const first = methods[0]?.id?.trim();
  if (!first) {
    return { promoted: false, paymentMethodId: null };
  }
  await ensureAppUserDefaultPaymentMethodAfterAttach({
    clientId: input.clientId,
    externalUserId: input.externalUserId,
    paymentMethodId: first,
  });
  return { promoted: true, paymentMethodId: first };
}

/**
 * Stripe invoice default `pm_…` for this app user, or null when none.
 * Merchant Connect reads the Connected Account customer; platform uses Konnect.
 * Throws when chargeability lookup fails (unknown) so callers fail closed.
 */
export async function resolveAppUserDefaultPaymentMethodId(input: {
  clientId: string;
  externalUserId: string;
}): Promise<string | null> {
  const chargeable = await appUserHasChargeablePaymentMethod(input);
  if (chargeable === null) {
    throw new Error("billing payment method lookup failed");
  }
  if (!chargeable) {
    return null;
  }
  const refs = await resolveAppUserStripeRefs(input);
  if (!refs) {
    return null;
  }
  if (refs.konnectDefaultPaymentMethodId) {
    return refs.konnectDefaultPaymentMethodId;
  }
  const signal = AbortSignal.timeout(OWNER_PAYMENT_METHOD_BUDGET_MS);
  const { items } = await buildOwnerPaymentMethodList({
    stripeCustomerId: refs.stripeCustomerId,
    konnectDefaultPaymentMethodId: refs.konnectDefaultPaymentMethodId,
    deps: {
      fetchImpl: fetch,
      signal,
      stripeAccount: refs.stripeAccount,
    },
  });
  return items.find((pm) => pm.isDefault)?.id?.trim() || null;
}

export async function restoreAppUserBillingProfileForCheckoutSession(
  sessionId: string,
  paymentMethodId?: string | null,
): Promise<boolean> {
  const normalizedSessionId = sessionId.trim();
  if (!normalizedSessionId) {
    return false;
  }
  const checkoutRows = await db
    .select({
      clientId: appUserPaymentMethodCheckouts.clientId,
      externalUserId: appUserPaymentMethodCheckouts.externalUserId,
    })
    .from(appUserPaymentMethodCheckouts)
    .where(
      eq(
        appUserPaymentMethodCheckouts.stripeCheckoutSessionId,
        normalizedSessionId,
      ),
    )
    .limit(1);
  const target = checkoutRows[0] ??
    (
      await db
        .select({
          clientId: subscriptions.clientId,
          externalUserId: subscriptions.externalUserId,
        })
        .from(subscriptions)
        .where(eq(subscriptions.stripeCheckoutSessionId, normalizedSessionId))
        .limit(1)
    )[0];
  if (!target?.clientId || !target.externalUserId) {
    return false;
  }
  await restoreAppUserBillingProfileAfterPaymentMethodAttached({
    ...target,
    paymentMethodId,
  });
  return true;
}

type AppUserStripeRefs = {
  customerId: string | null;
  stripeCustomerId: string;
  konnectDefaultPaymentMethodId: string | null;
  stripeAccount: string | undefined;
};

function stripeSecretKeyOrNull(): string | null {
  const key =
    process.env.STRIPE_SECRET_KEY?.trim() || process.env.STRIPE_API_KEY?.trim();
  if (!key?.startsWith("sk_")) {
    return null;
  }
  return key;
}

/**
 * True when add-card checkout must use Merchant Connect (or block) instead of
 * Konnect Stripe-app Checkout (Custom Invoicing profiles reject the latter).
 */
export function appUserPaymentMethodRequiresMerchantConnect(
  billingConfig:
    | Awaited<ReturnType<typeof getAppBillingConfig>>
    | null
    | undefined,
): boolean {
  return (
    connectPaymentsOnlyEnabled(billingConfig) ||
    billingConfig?.billingMode === "merchant"
  );
}

/**
 * Accept https (or localhost http) Checkout return URLs; otherwise fall back.
 * Prevents authenticated callers from redirecting post-checkout to arbitrary
 * phishing origins.
 */
export function resolveAppUserCheckoutReturnUrl(
  candidate: string | undefined,
  fallback: string,
): string {
  const raw = candidate?.trim();
  if (!raw) return fallback;
  try {
    const url = new URL(raw);
    const host = url.hostname.toLowerCase();
    const isLocalHttp =
      url.protocol === "http:" &&
      (host === "localhost" || host === "127.0.0.1" || host === "[::1]");
    if (url.protocol !== "https:" && !isLocalHttp) {
      return fallback;
    }
    return url.toString();
  } catch {
    return fallback;
  }
}

/**
 * List payment methods on the app end-user's Stripe customer (not owner wallet).
 * Lookup-only — returns [] when the customer does not exist yet / Connect is
 * not ready / Stripe is unconfigured. Provider failures propagate so wallet
 * M2M (`…/billing/wallet/payment-methods`) can map them to 502/503; UI list
 * routes should catch and fail open to `[]`.
 */
export async function listAppUserPaymentMethods(input: {
  clientId: string;
  externalUserId: string;
}): Promise<AppUserPaymentMethodListItem[]> {
  const clientId = input.clientId.trim();
  const externalUserId = input.externalUserId.trim();
  if (!clientId || !externalUserId) {
    return [];
  }
  if (!stripeSecretKeyOrNull()) {
    return [];
  }

  const billingConfig = await getAppBillingConfig(clientId);
  if (appUserPaymentMethodRequiresMerchantConnect(billingConfig)) {
    if (!isMerchantConnectPaymentsReady(billingConfig)) {
      return [];
    }
    const connectedAccountId =
      billingConfig?.stripeConnectedAccountId?.trim() || "";
    const merchantCustomer = await getAppUserStripeCustomer({
      clientId,
      externalUserId,
    });
    if (
      !connectedAccountId ||
      merchantCustomer?.stripeConnectedAccountId !== connectedAccountId ||
      !merchantCustomer.stripeCustomerId?.trim()
    ) {
      return [];
    }

    const signal = AbortSignal.timeout(OWNER_PAYMENT_METHOD_BUDGET_MS);
    const { items } = await buildOwnerPaymentMethodList({
      stripeCustomerId: merchantCustomer.stripeCustomerId,
      konnectDefaultPaymentMethodId: null,
      deps: {
        fetchImpl: fetch,
        signal,
        stripeAccount: connectedAccountId,
      },
    });
    return items;
  }

  if (!isHostedAdminClientAvailable()) {
    return [];
  }
  const client = getHostedAdminClient();
  const publicClientId = await resolveOpenMeterMeterClientId(clientId);
  const customerKey = buildOpenMeterCustomerKey(publicClientId, externalUserId);
  const customer = await findOpenMeterCustomerByKey(client, customerKey);
  const customerId = customer?.id?.trim();
  if (!customerId) {
    return [];
  }
  const signal = AbortSignal.timeout(OWNER_PAYMENT_METHOD_BUDGET_MS);
  const konnect = await getKonnectStripeBillingRefs(customerId, signal);
  const stripeCustomerId =
    konnect.stripeCustomerId ??
    (await getStripeCustomerAppDataId({
      client,
      customerId,
    }));
  if (!stripeCustomerId) {
    return [];
  }
  const { items } = await buildOwnerPaymentMethodList({
    stripeCustomerId,
    konnectDefaultPaymentMethodId: konnect.defaultPaymentMethodId,
    deps: { fetchImpl: fetch, signal },
  });
  return items;
}

/**
 * Whether Stripe can charge this app user's default payment method.
 * `null` = unknown (Stripe/OM outage) — mint/signer must fail closed on overage.
 * Merchant mode requires Connect-ready + customer on the connected account.
 */
export async function appUserHasChargeablePaymentMethod(input: {
  clientId: string;
  externalUserId: string;
}): Promise<boolean | null> {
  const clientId = input.clientId.trim();
  const externalUserId = input.externalUserId.trim();
  if (!clientId || !externalUserId) {
    return false;
  }
  if (!stripeSecretKeyOrNull()) {
    return null;
  }

  try {
    const refs = await resolveAppUserStripeRefs({ clientId, externalUserId });
    if (!refs) {
      return false;
    }
    if (refs.konnectDefaultPaymentMethodId) {
      return true;
    }
    // Default PM only — attached-but-not-default cannot charge_automatically.
    const signal = AbortSignal.timeout(OWNER_PAYMENT_METHOD_BUDGET_MS);
    const { items } = await buildOwnerPaymentMethodList({
      stripeCustomerId: refs.stripeCustomerId,
      konnectDefaultPaymentMethodId: refs.konnectDefaultPaymentMethodId,
      deps: {
        fetchImpl: fetch,
        signal,
        stripeAccount: refs.stripeAccount,
      },
    });
    return items.some((pm) => pm.isDefault);
  } catch (err) {
    console.warn(
      "app-user-payment-method: chargeability lookup failed",
      sanitizeForLog(err),
    );
    return null;
  }
}

async function resolveAppUserStripeRefs(input: {
  clientId: string;
  externalUserId: string;
}): Promise<AppUserStripeRefs | null> {
  const billingConfig = await getAppBillingConfig(input.clientId);
  if (appUserPaymentMethodRequiresMerchantConnect(billingConfig)) {
    if (!isMerchantConnectPaymentsReady(billingConfig)) {
      return null;
    }
    const stripeAccount = billingConfig?.stripeConnectedAccountId?.trim();
    const merchantCustomer = await getAppUserStripeCustomer(input);
    if (
      !stripeAccount ||
      merchantCustomer?.stripeConnectedAccountId !== stripeAccount ||
      !merchantCustomer.stripeCustomerId?.trim()
    ) {
      return null;
    }
    return {
      customerId: null,
      stripeCustomerId: merchantCustomer.stripeCustomerId,
      konnectDefaultPaymentMethodId: null,
      stripeAccount,
    };
  }

  if (!isHostedAdminClientAvailable()) {
    return null;
  }
  const client = getHostedAdminClient();
  const publicClientId = await resolveOpenMeterMeterClientId(input.clientId);
  const customerKey = buildOpenMeterCustomerKey(
    publicClientId,
    input.externalUserId,
  );
  const customer = await findOpenMeterCustomerByKey(client, customerKey);
  const customerId = customer?.id?.trim();
  if (!customerId) {
    return null;
  }
  const signal = AbortSignal.timeout(OWNER_PAYMENT_METHOD_BUDGET_MS);
  const konnect = await getKonnectStripeBillingRefs(customerId, signal);
  const stripeCustomerId =
    konnect.stripeCustomerId ??
    (await getStripeCustomerAppDataId({ client, customerId }));
  if (!stripeCustomerId) {
    return null;
  }
  return {
    customerId,
    stripeCustomerId,
    konnectDefaultPaymentMethodId: konnect.defaultPaymentMethodId,
    stripeAccount: undefined,
  };
}

/** Detach an app user's payment method from its merchant or platform customer. */
export async function unlinkAppUserPaymentMethod(input: {
  clientId: string;
  externalUserId: string;
  paymentMethodId: string;
}): Promise<{ unlinked: boolean; paymentMethodId: string | null }> {
  const refs = await resolveAppUserStripeRefs(input);
  if (!refs) {
    return { unlinked: false, paymentMethodId: null };
  }
  const result = await unlinkStripeCustomerPaymentMethod({
    stripeCustomerId: refs.stripeCustomerId,
    paymentMethodId: input.paymentMethodId,
    stripeAccount: refs.stripeAccount,
  });
  if (
    refs.customerId &&
    (result.wasDefault ||
      refs.konnectDefaultPaymentMethodId === input.paymentMethodId.trim())
  ) {
    await clearKonnectStripeDefaultPaymentMethod({
      customerId: refs.customerId,
      stripeCustomerId: refs.stripeCustomerId,
    });
  }
  return {
    unlinked: result.unlinked,
    paymentMethodId: result.paymentMethodId,
  };
}

/** Set the Stripe invoice default for an app user's merchant or platform customer. */
export async function setAppUserDefaultPaymentMethod(input: {
  clientId: string;
  externalUserId: string;
  paymentMethodId: string;
}): Promise<{ updated: boolean; paymentMethodId: string | null }> {
  const refs = await resolveAppUserStripeRefs(input);
  if (!refs) {
    return { updated: false, paymentMethodId: null };
  }
  const result = await setStripeCustomerDefaultPaymentMethod({
    stripeCustomerId: refs.stripeCustomerId,
    paymentMethodId: input.paymentMethodId,
    stripeAccount: refs.stripeAccount,
  });
  if (result.updated && refs.customerId) {
    await setKonnectStripeDefaultPaymentMethod({
      customerId: refs.customerId,
      stripeCustomerId: refs.stripeCustomerId,
      paymentMethodId: input.paymentMethodId.trim(),
    });
  }
  return result;
}

/**
 * Start setup-only Stripe Checkout for the app end-user's compound-key customer.
 * Does not change the user's plan/subscription and never redirects to the
 * owner-wallet customer path.
 */
export async function createAppUserPaymentMethodCheckout(input: {
  clientId: string;
  externalUserId: string;
  successUrl?: string;
  cancelUrl?: string;
}): Promise<AppUserPaymentMethodCheckoutResult> {
  const clientId = input.clientId.trim();
  const externalUserId = input.externalUserId.trim();
  if (!clientId || !externalUserId) {
    throw new Error("clientId and externalUserId are required");
  }

  const client = getHostedAdminClient();
  const publicClientId = await resolveOpenMeterMeterClientId(clientId);
  const customerKey = buildOpenMeterCustomerKey(publicClientId, externalUserId);
  const customer = await ensureOpenMeterCustomer(client, customerKey);
  await prepareAppCustomerStripeBilling({
    client,
    clientId,
    customerId: customer.id,
    customerKey: customer.key,
  });

  const billingConfig = await getAppBillingConfig(clientId);
  const merchantReady = isMerchantConnectPaymentsReady(billingConfig);
  if (
    !merchantReady &&
    appUserPaymentMethodRequiresMerchantConnect(billingConfig)
  ) {
    throw new Error(
      "Merchant Stripe Connect onboarding is required before adding a payment method",
    );
  }

  const hasDefault =
    (await appUserHasChargeablePaymentMethod({ clientId, externalUserId })) ===
    true;
  const origin = getPublicOrigin();
  const fallback = appSettingsAbsoluteUrl(origin, clientId, "payments");
  const success = resolveAppUserCheckoutReturnUrl(input.successUrl, fallback);
  const cancel = resolveAppUserCheckoutReturnUrl(input.cancelUrl, fallback);

  if (merchantReady) {
    const connectCheckout = await createMerchantConnectCheckoutForUser({
      clientId,
      externalUserId,
      successUrl: success,
      cancelUrl: cancel,
      openmeterCustomerId: customer.id,
      openmeterCustomerKey: customer.key,
    });
    await recordAppUserPaymentMethodCheckout({
      sessionId: connectCheckout.sessionId,
      clientId,
      externalUserId,
    });
    return {
      checkoutUrl: connectCheckout.checkoutUrl,
      sessionId: connectCheckout.sessionId,
      customerId: customer.id,
      hasDefaultPaymentMethod: hasDefault,
    };
  }

  const checkout = await createOpenMeterStripeCheckoutSession({
    client,
    customerId: customer.id,
    successUrl: success,
    cancelUrl: cancel,
    currency: "USD",
  });
  await recordAppUserPaymentMethodCheckout({
    sessionId: checkout.sessionId,
    clientId,
    externalUserId,
  });

  return {
    checkoutUrl: checkout.checkoutUrl,
    sessionId: checkout.sessionId,
    customerId: customer.id,
    hasDefaultPaymentMethod: hasDefault,
  };
}
