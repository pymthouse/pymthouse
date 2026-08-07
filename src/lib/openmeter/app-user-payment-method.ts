import { appSettingsAbsoluteUrl } from "@/lib/apps/settings-paths";
import { getPublicOrigin } from "@/lib/oidc/issuer-urls";
import { sanitizeForLog } from "@/lib/sanitize-for-log";
import {
  getHostedAdminClient,
  isHostedAdminClientAvailable,
} from "./admin-client";
import { prepareAppCustomerStripeBilling } from "./billing-profiles";
import { buildOpenMeterCustomerKey } from "./customer-key";
import {
  ensureOpenMeterCustomer,
  findOpenMeterCustomerByKey,
} from "./customers";
import { resolveOpenMeterMeterClientId } from "./meter-client-id";
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
 * Lookup-only — returns [] when the customer does not exist yet.
 * Best-effort empty list on transport failures (parity with owner list).
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
  } catch (err) {
    console.warn("app-user-payment-method: list failed", sanitizeForLog(err));
    return [];
  }
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

  const defaultPm = await getKonnectDefaultPaymentMethodId(customer.id);
  const origin = getPublicOrigin();
  const fallback = appSettingsAbsoluteUrl(origin, clientId, "payments");
  const success = resolveAppUserCheckoutReturnUrl(input.successUrl, fallback);
  const cancel = resolveAppUserCheckoutReturnUrl(input.cancelUrl, fallback);

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
