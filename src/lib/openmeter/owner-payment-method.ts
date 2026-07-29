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

async function stripeRequestJson<T>(input: {
  method: string;
  path: string;
  body?: URLSearchParams;
}): Promise<T | null> {
  const apiKey = stripeSecretKeyOrNull();
  if (!apiKey) {
    return null;
  }
  const headers: Record<string, string> = {
    Authorization: `Bearer ${apiKey}`,
  };
  if (input.body) {
    headers["Content-Type"] = "application/x-www-form-urlencoded";
  }
  const response = await fetch(`https://api.stripe.com${input.path}`, {
    method: input.method,
    headers,
    body: input.body?.toString(),
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

type StripeCardPaymentMethod = {
  id?: string;
  type?: string;
  card?: {
    brand?: string | null;
    last4?: string | null;
    exp_month?: number | null;
    exp_year?: number | null;
  } | null;
};

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

async function listStripeCustomerCards(
  stripeCustomerId: string,
): Promise<StripeCardPaymentMethod[]> {
  const listed = await stripeRequestJson<{
    data?: StripeCardPaymentMethod[];
  }>({
    method: "GET",
    path: `/v1/customers/${encodeURIComponent(stripeCustomerId)}/payment_methods?type=card&limit=10`,
  });
  return (listed?.data ?? []).filter((pm) => Boolean(pm.id?.trim()));
}

async function resolvePreferredCard(input: {
  openMeterCustomerId: string;
  stripeCustomerId: string;
}): Promise<StripeCardPaymentMethod | null> {
  const cards = await listStripeCustomerCards(input.stripeCustomerId);
  if (cards.length === 0) {
    return null;
  }

  const preferredIds: string[] = [];
  const fromKonnect = await getKonnectDefaultPaymentMethodId(
    input.openMeterCustomerId,
  );
  if (fromKonnect) {
    preferredIds.push(fromKonnect);
  }

  const customer = await stripeRequestJson<{
    invoice_settings?: { default_payment_method?: string | null };
  }>({
    method: "GET",
    path: `/v1/customers/${encodeURIComponent(input.stripeCustomerId)}`,
  });
  const fromInvoice =
    customer?.invoice_settings?.default_payment_method?.trim() || null;
  if (fromInvoice?.startsWith("pm_")) {
    preferredIds.push(fromInvoice);
  }

  for (const preferredId of preferredIds) {
    const match = cards.find((pm) => pm.id === preferredId);
    if (match) {
      return match;
    }
  }
  return cards[0] ?? null;
}

async function resolveOwnerStripeCustomer(ownerUserId: string): Promise<{
  openMeterCustomerId: string;
  stripeCustomerId: string;
} | null> {
  if (!isHostedAdminClientAvailable() || !stripeSecretKeyOrNull()) {
    return null;
  }
  const client = getHostedAdminClient();
  const publicClientIds = await listOwnedPublicClientIds(ownerUserId);
  const customer = await ensureOwnerCustomer(
    client,
    ownerUserId,
    publicClientIds,
  );
  const stripeCustomerId = await getStripeCustomerAppDataId({
    client,
    customerId: customer.id,
  });
  if (!stripeCustomerId) {
    return null;
  }
  return {
    openMeterCustomerId: customer.id,
    stripeCustomerId,
  };
}

/**
 * Best-effort read of the owner's default Stripe card for the billing page.
 * Returns null when OpenMeter/Stripe is unavailable or no PM is on file.
 */
export async function getOwnerDefaultPaymentMethod(
  ownerUserId: string,
): Promise<OwnerPaymentMethodSummary | null> {
  const trimmed = ownerUserId.trim();
  if (!trimmed) {
    return null;
  }

  try {
    const resolved = await resolveOwnerStripeCustomer(trimmed);
    if (!resolved) {
      return null;
    }
    const card = await resolvePreferredCard(resolved);
    return card ? summarizeStripePaymentMethod(card) : null;
  } catch (err) {
    console.warn(
      "owner-payment-method: lookup failed",
      err instanceof Error ? err.message : String(err),
    );
    return null;
  }
}

/**
 * Detach the owner's default Stripe card so overage invoices stop charging it.
 * Clears Stripe's customer default; Konnect app_data refreshes on the next OM sync.
 */
export async function unlinkOwnerPaymentMethod(
  ownerUserId: string,
): Promise<{ unlinked: boolean; paymentMethodId: string | null }> {
  const trimmed = ownerUserId.trim();
  if (!trimmed) {
    throw new Error("ownerUserId is required");
  }

  const resolved = await resolveOwnerStripeCustomer(trimmed);
  if (!resolved) {
    return { unlinked: false, paymentMethodId: null };
  }

  const card = await resolvePreferredCard(resolved);
  const pmId = card?.id?.trim();
  if (!pmId) {
    return { unlinked: false, paymentMethodId: null };
  }

  const detached = await stripeRequestJson<{ id?: string }>({
    method: "POST",
    path: `/v1/payment_methods/${encodeURIComponent(pmId)}/detach`,
  });
  if (!detached?.id) {
    throw new Error("Stripe could not detach the payment method");
  }

  // Best-effort: clear invoice default so Stripe does not keep a dangling pointer.
  await stripeRequestJson({
    method: "POST",
    path: `/v1/customers/${encodeURIComponent(resolved.stripeCustomerId)}`,
    body: new URLSearchParams({
      "invoice_settings[default_payment_method]": "",
    }),
  });

  return { unlinked: true, paymentMethodId: pmId };
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
