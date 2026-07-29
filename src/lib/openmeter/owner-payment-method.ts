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
  getKonnectStripeBillingRefs,
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

/**
 * Total budget for one payment-method resolution, shared by every Stripe and
 * Konnect call it makes. Callers on a render path must allow more than this so
 * the inner deadline wins and a partial answer is still returned.
 */
export const OWNER_PAYMENT_METHOD_BUDGET_MS = 6_000;

/** Budget for the owner-initiated unlink, which is not on a paint path. */
const UNLINK_BUDGET_MS = 15_000;

type StripeFetch = (
  input: string,
  init?: RequestInit,
) => Promise<Response>;

/** Injectable HTTP seam plus the shared deadline for one resolution. */
type StripeDeps = {
  fetchImpl: StripeFetch;
  signal: AbortSignal;
};

async function stripeRequestJson<T>(input: {
  method: string;
  path: string;
  body?: URLSearchParams;
  deps: StripeDeps;
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
  let response: Response;
  try {
    response = await input.deps.fetchImpl(
      `https://api.stripe.com${input.path}`,
      {
        method: input.method,
        headers,
        body: input.body?.toString(),
        signal: input.deps.signal,
      },
    );
  } catch (err) {
    console.warn(
      `owner-payment-method: Stripe ${input.method} ${input.path} failed`,
      err instanceof Error ? err.message : String(err),
    );
    return null;
  }
  if (!response.ok) {
    let detail = "";
    try {
      detail = (await response.text()).slice(0, 200);
    } catch {
      detail = "";
    }
    console.warn(
      `owner-payment-method: Stripe ${input.method} ${input.path} → ${response.status}`,
      detail,
    );
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

function asCard(value: unknown): StripeCardPaymentMethod | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const pm = value as StripeCardPaymentMethod;
  return pm.id?.trim() ? pm : null;
}

function asPaymentMethodId(value: unknown): string | null {
  if (typeof value === "string") {
    return value.trim() || null;
  }
  return asCard(value)?.id?.trim() || null;
}

function hasCardLast4(pm: StripeCardPaymentMethod | null | undefined): boolean {
  return Boolean(pm?.card?.last4?.trim());
}

/**
 * Expanding invoice_settings.default_payment_method returns the whole payment
 * method inline, so the common case costs one request and already carries
 * brand/last4 — no follow-up retrieve.
 */
async function getCustomerDefaultCard(
  stripeCustomerId: string,
  deps: StripeDeps,
): Promise<{ card: StripeCardPaymentMethod | null; id: string | null }> {
  const customer = await stripeRequestJson<{
    invoice_settings?: { default_payment_method?: unknown };
  }>({
    method: "GET",
    path:
      `/v1/customers/${encodeURIComponent(stripeCustomerId)}` +
      `?expand[]=invoice_settings.default_payment_method`,
    deps,
  });
  const value = customer?.invoice_settings?.default_payment_method;
  return { card: asCard(value), id: asPaymentMethodId(value) };
}

async function listStripeCustomerCards(
  stripeCustomerId: string,
  deps: StripeDeps,
): Promise<StripeCardPaymentMethod[]> {
  const listed = await stripeRequestJson<{
    data?: StripeCardPaymentMethod[];
  }>({
    method: "GET",
    path: `/v1/customers/${encodeURIComponent(stripeCustomerId)}/payment_methods?type=card&limit=10`,
    deps,
  });
  return (listed?.data ?? []).filter((pm) => Boolean(pm.id?.trim()));
}

async function retrieveStripePaymentMethod(
  paymentMethodId: string,
  deps: StripeDeps,
): Promise<StripeCardPaymentMethod | null> {
  return stripeRequestJson<StripeCardPaymentMethod>({
    method: "GET",
    path: `/v1/payment_methods/${encodeURIComponent(paymentMethodId)}`,
    deps,
  });
}

/**
 * @internal Exported for unit tests: the resolution order is the part that
 * regressed, and it depends only on the injected Stripe fetch.
 */
export async function resolvePreferredCard(input: {
  stripeCustomerId: string;
  /** Default payment method Konnect has on file, when it knows one. */
  konnectDefaultPaymentMethodId: string | null;
  deps: StripeDeps;
}): Promise<StripeCardPaymentMethod | null> {
  const { deps } = input;
  const stripeDefault = await getCustomerDefaultCard(
    input.stripeCustomerId,
    deps,
  );
  if (hasCardLast4(stripeDefault.card)) {
    return stripeDefault.card;
  }

  const preferredId =
    input.konnectDefaultPaymentMethodId ?? stripeDefault.id;
  if (preferredId && preferredId !== stripeDefault.card?.id) {
    const retrieved = await retrieveStripePaymentMethod(preferredId, deps);
    if (hasCardLast4(retrieved)) {
      return retrieved;
    }
  }

  // Anything without card fields (a bank account, a stale pointer) is dropped
  // rather than rendered as an unlabelled "Card ···· ····".
  const cards = await listStripeCustomerCards(input.stripeCustomerId, deps);
  return cards.find(hasCardLast4) ?? cards[0] ?? null;
}

type OwnerStripeRefs = {
  stripeCustomerId: string;
  konnectDefaultPaymentMethodId: string | null;
};

async function resolveOwnerStripeRefs(
  ownerUserId: string,
  signal: AbortSignal,
): Promise<OwnerStripeRefs | null> {
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

  // One Konnect /billing read yields both the Stripe customer and its default
  // payment method.
  const konnect = await getKonnectStripeBillingRefs(customer.id, signal);
  const stripeCustomerId =
    konnect.stripeCustomerId ??
    (await getStripeCustomerAppDataId({ client, customerId: customer.id }));
  if (!stripeCustomerId) {
    return null;
  }
  return {
    stripeCustomerId,
    konnectDefaultPaymentMethodId: konnect.defaultPaymentMethodId,
  };
}

async function resolveOwnerCard(
  ownerUserId: string,
  budgetMs: number,
): Promise<{
  refs: OwnerStripeRefs;
  card: StripeCardPaymentMethod | null;
} | null> {
  const signal = AbortSignal.timeout(budgetMs);
  const refs = await resolveOwnerStripeRefs(ownerUserId, signal);
  if (!refs) {
    return null;
  }
  const card = await resolvePreferredCard({
    stripeCustomerId: refs.stripeCustomerId,
    konnectDefaultPaymentMethodId: refs.konnectDefaultPaymentMethodId,
    deps: { fetchImpl: fetch, signal },
  });
  return { refs, card };
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
    const resolved = await resolveOwnerCard(
      trimmed,
      OWNER_PAYMENT_METHOD_BUDGET_MS,
    );
    return resolved?.card
      ? summarizeStripePaymentMethod(resolved.card)
      : null;
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

  const resolved = await resolveOwnerCard(trimmed, UNLINK_BUDGET_MS);
  const pmId = resolved?.card?.id?.trim();
  if (!resolved || !pmId) {
    return { unlinked: false, paymentMethodId: null };
  }

  const deps: StripeDeps = {
    fetchImpl: fetch,
    signal: AbortSignal.timeout(UNLINK_BUDGET_MS),
  };
  const detached = await stripeRequestJson<{ id?: string }>({
    method: "POST",
    path: `/v1/payment_methods/${encodeURIComponent(pmId)}/detach`,
    deps,
  });
  if (!detached?.id) {
    throw new Error("Stripe could not detach the payment method");
  }

  // Best-effort: clear invoice default so Stripe does not keep a dangling pointer.
  await stripeRequestJson({
    method: "POST",
    path: `/v1/customers/${encodeURIComponent(resolved.refs.stripeCustomerId)}`,
    body: new URLSearchParams({
      "invoice_settings[default_payment_method]": "",
    }),
    deps,
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
