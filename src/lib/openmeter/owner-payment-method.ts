import { getPublicOrigin } from "@/lib/oidc/issuer-urls";
import { getHostedAdminClient, isHostedAdminClientAvailable } from "./admin-client";
import { prepareOwnerCustomerStripeBilling } from "./billing-profiles";
import {
  ensureOwnerCustomer,
  listOwnedPublicClientIds,
} from "./customers";
import { createOpenMeterStripeCheckoutSession } from "./stripe-checkout-session";
import {
  getKonnectDefaultPaymentMethodId,
  getStripeCustomerAppDataId,
} from "./stripe-customer-data";

export type OwnerPaymentMethodCheckoutResult = {
  checkoutUrl: string;
  sessionId: string | null;
  customerId: string;
  /** True when Konnect already has a default payment method on file. */
  hasDefaultPaymentMethod: boolean;
};

/** Display summary of the owner's default Stripe payment method (Plane A). */
export type OwnerPaymentMethodSummary = {
  id: string;
  brand: string | null;
  last4: string | null;
  expMonth: number | null;
  expYear: number | null;
};

function stripeSecretKeyOrNull(): string | null {
  const key =
    process.env.STRIPE_SECRET_KEY?.trim() || process.env.STRIPE_API_KEY?.trim();
  if (!key || !key.startsWith("sk_")) {
    return null;
  }
  return key;
}

async function stripeGetJson<T>(path: string): Promise<T | null> {
  const apiKey = stripeSecretKeyOrNull();
  if (!apiKey) {
    return null;
  }
  const response = await fetch(`https://api.stripe.com${path}`, {
    method: "GET",
    headers: { Authorization: `Bearer ${apiKey}` },
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) {
    return null;
  }
  try {
    return (await response.json()) as T;
  } catch {
    return null;
  }
}

/** @internal Exported for unit tests. */
export function summarizeStripePaymentMethod(pm: {
  id?: string;
  card?: {
    brand?: string | null;
    last4?: string | null;
    exp_month?: number | null;
    exp_year?: number | null;
  } | null;
}): OwnerPaymentMethodSummary | null {
  const id = pm.id?.trim();
  if (!id) {
    return null;
  }
  return {
    id,
    brand: pm.card?.brand?.trim() || null,
    last4: pm.card?.last4?.trim() || null,
    expMonth:
      typeof pm.card?.exp_month === "number" ? pm.card.exp_month : null,
    expYear: typeof pm.card?.exp_year === "number" ? pm.card.exp_year : null,
  };
}

async function resolveDefaultPaymentMethodId(input: {
  openMeterCustomerId: string;
  stripeCustomerId: string;
}): Promise<string | null> {
  const fromKonnect = await getKonnectDefaultPaymentMethodId(
    input.openMeterCustomerId,
  );
  if (fromKonnect) {
    return fromKonnect;
  }

  const customer = await stripeGetJson<{
    invoice_settings?: { default_payment_method?: string | null };
    default_source?: string | null;
  }>(`/v1/customers/${encodeURIComponent(input.stripeCustomerId)}`);
  const fromInvoice =
    customer?.invoice_settings?.default_payment_method?.trim() || null;
  if (fromInvoice?.startsWith("pm_")) {
    return fromInvoice;
  }

  const listed = await stripeGetJson<{
    data?: Array<{ id?: string }>;
  }>(
    `/v1/customers/${encodeURIComponent(input.stripeCustomerId)}/payment_methods?type=card&limit=1`,
  );
  return listed?.data?.[0]?.id?.trim() || null;
}

/**
 * Best-effort read of the owner's default Stripe card for the billing page.
 * Returns null when OpenMeter/Stripe is unavailable or no PM is on file.
 */
export async function getOwnerDefaultPaymentMethod(
  ownerUserId: string,
): Promise<OwnerPaymentMethodSummary | null> {
  const trimmed = ownerUserId.trim();
  if (!trimmed || !isHostedAdminClientAvailable() || !stripeSecretKeyOrNull()) {
    return null;
  }

  try {
    const client = getHostedAdminClient();
    const publicClientIds = await listOwnedPublicClientIds(trimmed);
    const customer = await ensureOwnerCustomer(
      client,
      trimmed,
      publicClientIds,
    );
    const stripeCustomerId = await getStripeCustomerAppDataId({
      client,
      customerId: customer.id,
    });
    if (!stripeCustomerId) {
      return null;
    }

    const pmId = await resolveDefaultPaymentMethodId({
      openMeterCustomerId: customer.id,
      stripeCustomerId,
    });
    if (!pmId) {
      return null;
    }

    const pm = await stripeGetJson<{
      id?: string;
      card?: {
        brand?: string | null;
        last4?: string | null;
        exp_month?: number | null;
        exp_year?: number | null;
      } | null;
    }>(`/v1/payment_methods/${encodeURIComponent(pmId)}`);
    return pm ? summarizeStripePaymentMethod(pm) : null;
  } catch (err) {
    console.warn(
      "owner-payment-method: lookup failed",
      err instanceof Error ? err.message : String(err),
    );
    return null;
  }
}

/**
 * Start an OpenMeter Stripe Checkout session (always setup mode) so the owner
 * can attach a card for Plane A overage invoices (charge_automatically).
 */
export async function createOwnerPaymentMethodCheckout(input: {
  ownerUserId: string;
  successUrl?: string;
  cancelUrl?: string;
}): Promise<OwnerPaymentMethodCheckoutResult> {
  const ownerUserId = input.ownerUserId.trim();
  if (!ownerUserId) {
    throw new Error("ownerUserId is required");
  }

  const client = getHostedAdminClient();
  const publicClientIds = await listOwnedPublicClientIds(ownerUserId);
  const customer = await ensureOwnerCustomer(
    client,
    ownerUserId,
    publicClientIds,
  );
  await prepareOwnerCustomerStripeBilling({
    client,
    customerId: customer.id,
    customerKey: customer.key,
  });

  const defaultPm = await getKonnectDefaultPaymentMethodId(customer.id);
  const origin = getPublicOrigin();
  const success =
    input.successUrl?.trim() || `${origin}/billing?pm=attached`;
  const cancel = input.cancelUrl?.trim() || `${origin}/billing`;

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
