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
  setKonnectStripeDefaultPaymentMethod,
} from "./stripe-customer-data";

export type OwnerPaymentMethodCheckoutResult = {
  checkoutUrl: string;
  sessionId: string | null;
  customerId: string;
  /** True when Konnect already has a default payment method on file. */
  hasDefaultPaymentMethod: boolean;
};

/**
 * One attached Stripe payment method, labelled for self-service management.
 * Only brand + last4 are returned — no billing name/email/ZIP. Stripe Link
 * never exposes the funding card's last4, so those rows are brand-only.
 */
export type OwnerPaymentMethodListItem = {
  id: string;
  type: string;
  brand: string | null;
  last4: string | null;
  expMonth: number | null;
  expYear: number | null;
  isDefault: boolean;
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
 * Total budget for one payment-method listing, shared by every Stripe and
 * Konnect call it makes. Callers on a render path must allow more than this so
 * the inner deadline wins and a partial answer is still returned.
 */
export const OWNER_PAYMENT_METHOD_BUDGET_MS = 6_000;

/** Budget for owner-initiated mutations, which are not on a paint path. */
const MUTATION_BUDGET_MS = 15_000;

type StripeFetch = (
  input: string,
  init?: RequestInit,
) => Promise<Response>;

/** Injectable HTTP seam plus the shared deadline for one resolution. */
type StripeDeps = {
  fetchImpl: StripeFetch;
  signal: AbortSignal;
};

function liveStripeDeps(budgetMs: number): StripeDeps {
  return { fetchImpl: fetch, signal: AbortSignal.timeout(budgetMs) };
}

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

type StripePaymentMethod = {
  id?: string;
  type?: string;
  customer?: string | null;
  card?: {
    brand?: string | null;
    last4?: string | null;
    exp_month?: number | null;
    exp_year?: number | null;
  } | null;
  /** Checkout attaches Link methods with no card object (the funding card lives in Link). */
  link?: { email?: string | null } | null;
  us_bank_account?: {
    bank_name?: string | null;
    last4?: string | null;
  } | null;
};

/** @internal Exported for unit tests. */
export function toOwnerPaymentMethodItem(
  pm: StripePaymentMethod,
  defaultPaymentMethodId: string | null,
): OwnerPaymentMethodListItem | null {
  const id = pm.id?.trim();
  if (!id) {
    return null;
  }
  const type = pm.type?.trim().toLowerCase() || "unknown";
  let brand = pm.card?.brand?.trim() || null;
  if (!brand && type === "link") {
    brand = "link";
  }
  if (!brand && pm.us_bank_account) {
    brand = pm.us_bank_account.bank_name?.trim() || "bank";
  }
  return {
    id,
    type,
    brand,
    last4:
      pm.card?.last4?.trim() || pm.us_bank_account?.last4?.trim() || null,
    expMonth:
      typeof pm.card?.exp_month === "number" ? pm.card.exp_month : null,
    expYear: typeof pm.card?.exp_year === "number" ? pm.card.exp_year : null,
    isDefault: id === defaultPaymentMethodId,
  };
}

function asPaymentMethodId(value: unknown): string | null {
  if (typeof value === "string") {
    return value.trim() || null;
  }
  if (!value || typeof value !== "object") {
    return null;
  }
  return (value as StripePaymentMethod).id?.trim() || null;
}

/** Stripe's own invoice default, when set on the customer. */
async function getCustomerDefaultPaymentMethodId(
  stripeCustomerId: string,
  deps: StripeDeps,
): Promise<string | null> {
  const customer = await stripeRequestJson<{
    invoice_settings?: { default_payment_method?: unknown };
  }>({
    method: "GET",
    path: `/v1/customers/${encodeURIComponent(stripeCustomerId)}`,
    deps,
  });
  return asPaymentMethodId(customer?.invoice_settings?.default_payment_method);
}

/**
 * Unfiltered on purpose: a `type=card` filter hides the Link payment methods
 * Checkout attaches, which is what left owners on the "no payment method" state.
 */
async function listStripeCustomerPaymentMethods(
  stripeCustomerId: string,
  deps: StripeDeps,
): Promise<StripePaymentMethod[]> {
  const listed = await stripeRequestJson<{
    data?: StripePaymentMethod[];
  }>({
    method: "GET",
    path: `/v1/customers/${encodeURIComponent(stripeCustomerId)}/payment_methods?limit=100`,
    deps,
  });
  return (listed?.data ?? []).filter((pm) => Boolean(pm.id?.trim()));
}

async function retrieveStripePaymentMethod(
  paymentMethodId: string,
  deps: StripeDeps,
): Promise<StripePaymentMethod | null> {
  return stripeRequestJson<StripePaymentMethod>({
    method: "GET",
    path: `/v1/payment_methods/${encodeURIComponent(paymentMethodId)}`,
    deps,
  });
}

/**
 * Link payment methods are indistinguishable (Stripe never returns last4), so
 * keep at most one: the default if it is Link, otherwise the first Link seen.
 * @internal Exported for unit tests.
 */
export function collapseDuplicateLinkMethods(
  items: OwnerPaymentMethodListItem[],
): {
  kept: OwnerPaymentMethodListItem[];
  orphanLinkIds: string[];
} {
  const links = items.filter((item) => item.type === "link");
  if (links.length <= 1) {
    return { kept: items, orphanLinkIds: [] };
  }
  const keepId = (links.find((item) => item.isDefault) ?? links[0]).id;
  return {
    kept: items.filter(
      (item) => item.type !== "link" || item.id === keepId,
    ),
    orphanLinkIds: links
      .filter((item) => item.id !== keepId)
      .map((item) => item.id),
  };
}

/**
 * @internal Exported for unit tests: everything attached to the Stripe
 * customer, with the default flagged. Stripe's invoice default wins over the
 * Konnect app_data pointer when both exist. Duplicate Link methods are
 * collapsed to one (see collapseDuplicateLinkMethods).
 */
export async function buildOwnerPaymentMethodList(input: {
  stripeCustomerId: string;
  /** Default payment method Konnect has on file, when it knows one. */
  konnectDefaultPaymentMethodId: string | null;
  deps: StripeDeps;
}): Promise<{
  items: OwnerPaymentMethodListItem[];
  orphanLinkIds: string[];
}> {
  const [stripeDefaultId, listed] = await Promise.all([
    getCustomerDefaultPaymentMethodId(input.stripeCustomerId, input.deps),
    listStripeCustomerPaymentMethods(input.stripeCustomerId, input.deps),
  ]);
  const defaultId = stripeDefaultId ?? input.konnectDefaultPaymentMethodId;
  const mapped = listed
    .map((pm) => toOwnerPaymentMethodItem(pm, defaultId))
    .filter((item): item is OwnerPaymentMethodListItem => item !== null);
  const { kept, orphanLinkIds } = collapseDuplicateLinkMethods(mapped);
  // Default always leads; relative order of the rest is unchanged.
  const items = kept.toSorted(
    (a, b) => Number(b.isDefault) - Number(a.isDefault),
  );
  return { items, orphanLinkIds };
}

type OwnerStripeRefs = {
  /** OpenMeter/Konnect customer id (for app_data writes). */
  customerId: string;
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
    customerId: customer.id,
    stripeCustomerId,
    konnectDefaultPaymentMethodId: konnect.defaultPaymentMethodId,
  };
}

/**
 * Best-effort list of payment methods for the billing page. Duplicate Stripe
 * Link methods are collapsed to one (default preferred) and the extras are
 * detached so the customer cannot accumulate indistinguishable Links.
 * Returns [] when OpenMeter/Stripe is unavailable or none is on file.
 */
export async function listOwnerPaymentMethods(
  ownerUserId: string,
): Promise<OwnerPaymentMethodListItem[]> {
  const trimmed = ownerUserId.trim();
  if (!trimmed) {
    return [];
  }

  try {
    const signal = AbortSignal.timeout(OWNER_PAYMENT_METHOD_BUDGET_MS);
    const refs = await resolveOwnerStripeRefs(trimmed, signal);
    if (!refs) {
      return [];
    }
    const deps: StripeDeps = { fetchImpl: fetch, signal };
    const { items, orphanLinkIds } = await buildOwnerPaymentMethodList({
      stripeCustomerId: refs.stripeCustomerId,
      konnectDefaultPaymentMethodId: refs.konnectDefaultPaymentMethodId,
      deps,
    });
    // Best-effort cleanup; listing must still succeed if detach fails.
    await Promise.all(
      orphanLinkIds.map((id) =>
        stripeRequestJson({
          method: "POST",
          path: `/v1/payment_methods/${encodeURIComponent(id)}/detach`,
          deps,
        }),
      ),
    );
    return items;
  } catch (err) {
    console.warn(
      "owner-payment-method: lookup failed",
      err instanceof Error ? err.message : String(err),
    );
    return [];
  }
}

/**
 * The payment method, but only when it is attached to this owner's Stripe
 * customer — a session must not be able to manage someone else's method by id.
 */
async function requireOwnedPaymentMethod(
  refs: OwnerStripeRefs,
  paymentMethodId: string,
  deps: StripeDeps,
): Promise<StripePaymentMethod | null> {
  const pm = await retrieveStripePaymentMethod(paymentMethodId, deps);
  if (!pm?.id || pm.customer !== refs.stripeCustomerId) {
    return null;
  }
  return pm;
}

/**
 * Detach one payment method so overage invoices stop charging it. When it was
 * the default, Stripe's invoice default is cleared as well; Konnect app_data
 * refreshes on the next OM sync.
 */
export async function unlinkOwnerPaymentMethod(
  ownerUserId: string,
  paymentMethodId: string,
): Promise<{ unlinked: boolean; paymentMethodId: string | null }> {
  const trimmed = ownerUserId.trim();
  const pmId = paymentMethodId.trim();
  if (!trimmed || !pmId) {
    throw new Error("ownerUserId and paymentMethodId are required");
  }

  const deps = liveStripeDeps(MUTATION_BUDGET_MS);
  const refs = await resolveOwnerStripeRefs(trimmed, deps.signal);
  if (!refs || !(await requireOwnedPaymentMethod(refs, pmId, deps))) {
    return { unlinked: false, paymentMethodId: null };
  }

  const detached = await stripeRequestJson<{ id?: string }>({
    method: "POST",
    path: `/v1/payment_methods/${encodeURIComponent(pmId)}/detach`,
    deps,
  });
  if (!detached?.id) {
    throw new Error("Stripe could not detach the payment method");
  }

  // Best-effort: when the default was removed, do not leave a dangling pointer.
  const stripeDefaultId = await getCustomerDefaultPaymentMethodId(
    refs.stripeCustomerId,
    deps,
  );
  if (stripeDefaultId === pmId) {
    await stripeRequestJson({
      method: "POST",
      path: `/v1/customers/${encodeURIComponent(refs.stripeCustomerId)}`,
      body: new URLSearchParams({
        "invoice_settings[default_payment_method]": "",
      }),
      deps,
    });
  }

  return { unlinked: true, paymentMethodId: pmId };
}

/**
 * Make one attached payment method the default for overage invoices: sets
 * Stripe's customer invoice default and mirrors the pointer into Konnect
 * app_data so OpenMeter invoicing agrees with what the billing page shows.
 */
export async function setOwnerDefaultPaymentMethod(
  ownerUserId: string,
  paymentMethodId: string,
): Promise<{ updated: boolean; paymentMethodId: string | null }> {
  const trimmed = ownerUserId.trim();
  const pmId = paymentMethodId.trim();
  if (!trimmed || !pmId) {
    throw new Error("ownerUserId and paymentMethodId are required");
  }

  const deps = liveStripeDeps(MUTATION_BUDGET_MS);
  const refs = await resolveOwnerStripeRefs(trimmed, deps.signal);
  if (!refs || !(await requireOwnedPaymentMethod(refs, pmId, deps))) {
    return { updated: false, paymentMethodId: null };
  }

  const updated = await stripeRequestJson<{ id?: string }>({
    method: "POST",
    path: `/v1/customers/${encodeURIComponent(refs.stripeCustomerId)}`,
    body: new URLSearchParams({
      "invoice_settings[default_payment_method]": pmId,
    }),
    deps,
  });
  if (!updated?.id) {
    throw new Error("Stripe could not set the default payment method");
  }

  try {
    await setKonnectStripeDefaultPaymentMethod({
      customerId: refs.customerId,
      stripeCustomerId: refs.stripeCustomerId,
      paymentMethodId: pmId,
    });
  } catch (err) {
    console.warn(
      "owner-payment-method: Konnect default sync failed",
      err instanceof Error ? err.message : String(err),
    );
  }

  return { updated: true, paymentMethodId: pmId };
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
