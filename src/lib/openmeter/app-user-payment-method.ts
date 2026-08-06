import { appSettingsAbsoluteUrl } from "@/lib/apps/settings-paths";
import { getPublicOrigin } from "@/lib/oidc/issuer-urls";
import { sanitizeForLog } from "@/lib/sanitize-for-log";
import {
  getHostedAdminClient,
  isHostedAdminClientAvailable,
} from "./admin-client";
import { prepareAppCustomerStripeBilling } from "./billing-profiles";
import { ensureOpenMeterCustomerForAppUser } from "./customers";
import {
  buildOwnerPaymentMethodList,
  OWNER_PAYMENT_METHOD_BUDGET_MS,
  type OwnerPaymentMethodListItem,
} from "./owner-payment-method";
import { createOpenMeterStripeCheckoutSession } from "./stripe-checkout-session";
import {
  getKonnectDefaultPaymentMethodId,
  getKonnectStripeBillingRefs,
  getStripeCustomerAppDataId,
} from "./stripe-customer-data";

export type AppUserPaymentMethodListItem = OwnerPaymentMethodListItem;

export type AppUserPaymentMethodCheckoutResult = {
  checkoutUrl: string;
  sessionId: string | null;
  customerId: string;
  hasDefaultPaymentMethod: boolean;
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
 * List payment methods on the app end-user's Stripe customer (not owner wallet).
 * Returns [] when billing is unavailable or nothing is on file.
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
  if (!isHostedAdminClientAvailable() || !stripeSecretKeyOrNull()) {
    return [];
  }

  try {
    const client = getHostedAdminClient();
    const customer = await ensureOpenMeterCustomerForAppUser({
      client,
      clientId,
      externalUserId,
    });
    const signal = AbortSignal.timeout(OWNER_PAYMENT_METHOD_BUDGET_MS);
    const konnect = await getKonnectStripeBillingRefs(customer.id, signal);
    const stripeCustomerId =
      konnect.stripeCustomerId ??
      (await getStripeCustomerAppDataId({
        client,
        customerId: customer.id,
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
  } catch (err) {
    console.warn("app-user-payment-method: list failed", sanitizeForLog(err));
    return [];
  }
}

/**
 * Start setup-only Stripe Checkout for the app end-user's customer.
 * Does not change the user's plan/subscription.
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
  const customer = await ensureOpenMeterCustomerForAppUser({
    client,
    clientId,
    externalUserId,
  });
  await prepareAppCustomerStripeBilling({
    client,
    clientId,
    customerId: customer.id,
    customerKey: customer.key,
  });

  const defaultPm = await getKonnectDefaultPaymentMethodId(customer.id);
  const origin = getPublicOrigin();
  const success =
    input.successUrl?.trim() ||
    appSettingsAbsoluteUrl(origin, clientId, "payments");
  const cancel =
    input.cancelUrl?.trim() ||
    appSettingsAbsoluteUrl(origin, clientId, "payments");

  const checkout = await createOpenMeterStripeCheckoutSession({
    client,
    customerId: customer.id,
    successUrl: success,
    cancelUrl: cancel,
    currency: "USD",
  });

  return {
    checkoutUrl: checkout.checkoutUrl,
    sessionId: checkout.sessionId,
    customerId: customer.id,
    hasDefaultPaymentMethod: Boolean(defaultPm),
  };
}
