import { getPublicOrigin } from "@/lib/oidc/issuer-urls";
import { sanitizeForLog } from "@/lib/sanitize-for-log";
import { getHostedAdminClient, isHostedAdminClientAvailable } from "./admin-client";
import { prepareOwnerCustomerStripeBilling } from "./billing-profiles";
import {
  ensureOwnerCustomer,
  listOwnedPublicClientIds,
} from "./customers";
import { createOpenMeterStripeCheckoutSession } from "./stripe-checkout-session";
import {
  clearKonnectStripeDefaultPaymentMethod,
  getKonnectDefaultPaymentMethodId,
  getKonnectStripeBillingRefs,
  getStripeCustomerAppDataId,
  setKonnectStripeDefaultPaymentMethod,
} from "./stripe-customer-data";

const STRIPE_API_ORIGIN = "https://api.stripe.com";

/** Serialize payment-method mutations per owner (in-process). */
const ownerPaymentMethodLocks = new Map<string, Promise<unknown>>();

async function withOwnerPaymentMethodLock<T>(
  ownerUserId: string,
  fn: () => Promise<T>,
): Promise<T> {
  const key = ownerUserId.trim();
  const previous = ownerPaymentMethodLocks.get(key) ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const chained = previous.then(
    () => gate,
    () => gate,
  );
  ownerPaymentMethodLocks.set(key, chained);
  await previous.then(
    () => undefined,
    () => undefined,
  );
  try {
    return await fn();
  } finally {
    release();
    if (ownerPaymentMethodLocks.get(key) === chained) {
      ownerPaymentMethodLocks.delete(key);
    }
  }
}

/**
 * Build a Stripe REST URL from a relative `/v1/…` path only.
 * Rejects scheme/host injection so path segments (customer ids, etc.) cannot
 * redirect the request off api.stripe.com (tssecurity:S8476).
 * @internal Exported for unit tests.
 */
export function toStripeApiUrl(path: string): string {
  if (!/^\/v1\/[A-Za-z0-9/_.=?%&-]+$/.test(path) || path.includes("..")) {
    throw new Error("Invalid Stripe API path");
  }
  const url = new URL(path, STRIPE_API_ORIGIN);
  if (url.origin !== STRIPE_API_ORIGIN || !url.pathname.startsWith("/v1/")) {
    throw new Error("Stripe API origin mismatch");
  }
  return url.href;
}

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
  /** Routes the request to a merchant's Stripe Connected Account. */
  stripeAccount?: string;
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
  if (input.deps.stripeAccount) {
    headers["Stripe-Account"] = input.deps.stripeAccount;
  }
  if (input.body) {
    headers["Content-Type"] = "application/x-www-form-urlencoded";
  }
  let response: Response;
  try {
    response = await input.deps.fetchImpl(toStripeApiUrl(input.path), {
      method: input.method,
      headers,
      body: input.body?.toString(),
      signal: input.deps.signal,
    });
  } catch (err) {
    console.warn(
      "owner-payment-method: Stripe request failed",
      sanitizeForLog(input.method),
      sanitizeForLog(input.path),
      sanitizeForLog(err),
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
      "owner-payment-method: Stripe request not ok",
      sanitizeForLog(input.method),
      sanitizeForLog(input.path),
      sanitizeForLog(response.status),
      sanitizeForLog(detail),
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
 *
 * When the list endpoint returns nothing (or omits the known default id) but
 * Konnect/Stripe still has a default payment method id, retrieve that method
 * so billing UI does not falsely show "no payment method on file".
 */
export async function buildOwnerPaymentMethodList(input: {
  stripeCustomerId: string;
  /** Default payment method Konnect has on file, when it knows one. */
  konnectDefaultPaymentMethodId: string | null;
  /**
   * Use the first attached method when this customer has no persisted default.
   * Merchant Connect customers have no Konnect app_data default pointer.
   */
  defaultFirstPaymentMethod?: boolean;
  deps: StripeDeps;
}): Promise<{
  items: OwnerPaymentMethodListItem[];
  orphanLinkIds: string[];
}> {
  const [stripeDefaultId, listed] = await Promise.all([
    getCustomerDefaultPaymentMethodId(input.stripeCustomerId, input.deps),
    listStripeCustomerPaymentMethods(input.stripeCustomerId, input.deps),
  ]);
  const defaultId =
    stripeDefaultId ??
    input.konnectDefaultPaymentMethodId ??
    (input.defaultFirstPaymentMethod ? listed[0]?.id?.trim() || null : null);
  const byId = new Map<string, StripePaymentMethod>();
  for (const pm of listed) {
    const id = pm.id?.trim();
    if (id) byId.set(id, pm);
  }

  if (defaultId && !byId.has(defaultId)) {
    const retrieved = await retrieveStripePaymentMethod(defaultId, input.deps);
    const retrievedId = retrieved?.id?.trim();
    const customer = retrieved?.customer?.trim() || null;
    if (
      retrieved &&
      retrievedId &&
      customer &&
      customer === input.stripeCustomerId
    ) {
      byId.set(retrievedId, retrieved);
    }
  }

  const mapped = [...byId.values()]
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

/**
 * Resolve the owner's Stripe/Konnect customer refs for payment-method work.
 *
 * `signal` binds the Konnect `/billing` read (and Stripe calls that take deps).
 * `listOwnedPublicClientIds` / `ensureOwnerCustomer` / the Stripe-app-data
 * fallback do not accept AbortSignal today — they are Neon / OM SDK calls.
 * Callers that need a hard outer deadline (billing page paint) wrap this with
 * `withSoftTimeout`; when those steps overrun, the outer soft timeout wins and
 * returns [].
 */
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
 * List payment methods for the billing page. Duplicate Stripe Link methods are
 * collapsed to one (default preferred); extras are hidden from the list but
 * not detached — mutating Stripe belongs on owner-initiated PATCH/DELETE, not
 * this read path.
 * Returns [] when OpenMeter/Stripe is unavailable or none is on file.
 * Provider failures propagate so M2M callers can map them to 502/503.
 */
export async function listOwnerPaymentMethods(
  ownerUserId: string,
): Promise<OwnerPaymentMethodListItem[]> {
  const trimmed = ownerUserId.trim();
  if (!trimmed) {
    return [];
  }

  const signal = AbortSignal.timeout(OWNER_PAYMENT_METHOD_BUDGET_MS);
  const refs = await resolveOwnerStripeRefs(trimmed, signal);
  if (!refs) {
    return [];
  }
  const deps: StripeDeps = { fetchImpl: fetch, signal };
  const { items } = await buildOwnerPaymentMethodList({
    stripeCustomerId: refs.stripeCustomerId,
    konnectDefaultPaymentMethodId: refs.konnectDefaultPaymentMethodId,
    deps,
  });
  return items;
}

/**
 * Whether OpenMeter has something it can charge for this owner's platform
 * invoices. `null` means the answer is unknown — platform billing is not wired
 * up, or Stripe/OpenMeter could not be reached — so callers can fail open
 * instead of blocking on an outage.
 */
export async function ownerHasChargeablePaymentMethod(
  ownerUserId: string,
): Promise<boolean | null> {
  const trimmed = ownerUserId.trim();
  if (!trimmed) {
    return false;
  }
  if (!isHostedAdminClientAvailable() || !stripeSecretKeyOrNull()) {
    return null;
  }

  try {
    const deps = liveStripeDeps(OWNER_PAYMENT_METHOD_BUDGET_MS);
    const refs = await resolveOwnerStripeRefs(trimmed, deps.signal);
    // Past the availability check, no refs means the owner has no Stripe
    // customer yet, so there is nothing on file to charge.
    if (!refs) {
      return false;
    }
    if (refs.konnectDefaultPaymentMethodId) {
      return true;
    }
    return Boolean(
      await getCustomerDefaultPaymentMethodId(refs.stripeCustomerId, deps),
    );
  } catch (err) {
    console.warn(
      "owner-payment-method: chargeability lookup failed",
      sanitizeForLog(err),
    );
    return null;
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
 * Detach a method from one Stripe customer. This is shared by owner-wallet and
 * merchant Connected Account billing; callers own any Konnect app-data sync.
 */
export async function unlinkStripeCustomerPaymentMethod(input: {
  stripeCustomerId: string;
  paymentMethodId: string;
  stripeAccount?: string;
}): Promise<{
  unlinked: boolean;
  paymentMethodId: string | null;
  wasDefault: boolean;
}> {
  const stripeCustomerId = input.stripeCustomerId.trim();
  const paymentMethodId = input.paymentMethodId.trim();
  if (!stripeCustomerId || !paymentMethodId) {
    throw new Error("stripeCustomerId and paymentMethodId are required");
  }

  const lockKey = `${input.stripeAccount ?? "platform"}:${stripeCustomerId}`;
  return withOwnerPaymentMethodLock(lockKey, async () => {
    const deps: StripeDeps = {
      ...liveStripeDeps(MUTATION_BUDGET_MS),
      ...(input.stripeAccount ? { stripeAccount: input.stripeAccount } : {}),
    };
    const paymentMethod = await retrieveStripePaymentMethod(paymentMethodId, deps);
    if (paymentMethod?.customer !== stripeCustomerId) {
      return { unlinked: false, paymentMethodId: null, wasDefault: false };
    }

    const { items } = await buildOwnerPaymentMethodList({
      stripeCustomerId,
      konnectDefaultPaymentMethodId: null,
      deps,
    });
    if (items.length === 0) {
      throw new Error(
        "Unable to verify payment methods right now. Try again shortly.",
      );
    }
    if (items.length === 1 && items[0]?.id === paymentMethodId) {
      throw new Error(
        "This is your only payment method. Add another before removing this one.",
      );
    }

    const wasDefault = Boolean(
      await getCustomerDefaultPaymentMethodId(stripeCustomerId, deps).then(
        (defaultId) => defaultId === paymentMethodId,
      ),
    );
    const detached = await stripeRequestJson<{ id?: string }>({
      method: "POST",
      path: `/v1/payment_methods/${encodeURIComponent(paymentMethodId)}/detach`,
      deps,
    });
    if (!detached?.id) {
      throw new Error("Stripe could not detach the payment method");
    }

    if (wasDefault) {
      await stripeRequestJson({
        method: "POST",
        path: `/v1/customers/${encodeURIComponent(stripeCustomerId)}`,
        body: new URLSearchParams({
          "invoice_settings[default_payment_method]": "",
        }),
        deps,
      });
    }
    return { unlinked: true, paymentMethodId, wasDefault };
  });
}

/**
 * Set one attached method as a Stripe customer's invoice default. Merchant
 * Connected Account callers pass `stripeAccount`; platform callers do not.
 */
export async function setStripeCustomerDefaultPaymentMethod(input: {
  stripeCustomerId: string;
  paymentMethodId: string;
  stripeAccount?: string;
}): Promise<{ updated: boolean; paymentMethodId: string | null }> {
  const stripeCustomerId = input.stripeCustomerId.trim();
  const paymentMethodId = input.paymentMethodId.trim();
  if (!stripeCustomerId || !paymentMethodId) {
    throw new Error("stripeCustomerId and paymentMethodId are required");
  }

  const lockKey = `${input.stripeAccount ?? "platform"}:${stripeCustomerId}`;
  return withOwnerPaymentMethodLock(lockKey, async () => {
    const deps: StripeDeps = {
      ...liveStripeDeps(MUTATION_BUDGET_MS),
      ...(input.stripeAccount ? { stripeAccount: input.stripeAccount } : {}),
    };
    const paymentMethod = await retrieveStripePaymentMethod(paymentMethodId, deps);
    if (paymentMethod?.customer !== stripeCustomerId) {
      return { updated: false, paymentMethodId: null };
    }
    const updated = await stripeRequestJson<{ id?: string }>({
      method: "POST",
      path: `/v1/customers/${encodeURIComponent(stripeCustomerId)}`,
      body: new URLSearchParams({
        "invoice_settings[default_payment_method]": paymentMethodId,
      }),
      deps,
    });
    if (!updated?.id) {
      throw new Error("Stripe could not set the default payment method");
    }
    return { updated: true, paymentMethodId };
  });
}

/**
 * Detach one payment method so plan fee and overage invoices stop charging it.
 * When it was the default, both Stripe's invoice default and the Konnect
 * app_data pointer are cleared — leaving either behind lets OpenMeter keep
 * billing a detached method.
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

  return withOwnerPaymentMethodLock(trimmed, async () => {
    const deps = liveStripeDeps(MUTATION_BUDGET_MS);
    const refs = await resolveOwnerStripeRefs(trimmed, deps.signal);
    if (!refs || !(await requireOwnedPaymentMethod(refs, pmId, deps))) {
      return { unlinked: false, paymentMethodId: null };
    }

    const result = await unlinkStripeCustomerPaymentMethod({
      stripeCustomerId: refs.stripeCustomerId,
      paymentMethodId: pmId,
    });
    if (result.wasDefault || refs.konnectDefaultPaymentMethodId === pmId) {
      try {
        await clearKonnectStripeDefaultPaymentMethod({
          customerId: refs.customerId,
          stripeCustomerId: refs.stripeCustomerId,
        });
      } catch (err) {
        console.warn(
          "owner-payment-method: Konnect default clear failed",
          sanitizeForLog(err),
        );
      }
    }

    return { unlinked: result.unlinked, paymentMethodId: result.paymentMethodId };
  });
}

/**
 * Make one attached payment method the default for plan fee and overage
 * invoices: sets Stripe's customer invoice default and mirrors the pointer
 * into Konnect app_data so OpenMeter invoicing agrees with what the billing
 * page shows.
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

  return withOwnerPaymentMethodLock(trimmed, async () => {
    const deps = liveStripeDeps(MUTATION_BUDGET_MS);
    const refs = await resolveOwnerStripeRefs(trimmed, deps.signal);
    if (!refs || !(await requireOwnedPaymentMethod(refs, pmId, deps))) {
      return { updated: false, paymentMethodId: null };
    }

    const result = await setStripeCustomerDefaultPaymentMethod({
      stripeCustomerId: refs.stripeCustomerId,
      paymentMethodId: pmId,
    });
    if (!result.updated) return result;

    try {
      await setKonnectStripeDefaultPaymentMethod({
        customerId: refs.customerId,
        stripeCustomerId: refs.stripeCustomerId,
        paymentMethodId: pmId,
      });
    } catch (err) {
      console.warn(
        "owner-payment-method: Konnect default sync failed",
        sanitizeForLog(err),
      );
    }

    return result;
  });
}

/**
 * After setup Checkout return, call PATCH `{ ensureDefault: true }` from the
 * client (authenticated) to promote the first attached payment method to
 * Stripe+Konnect default when none is set yet. Do not mutate from GET
 * `?pm=attached` page renders. Plane A OM webhooks usually do this; this
 * covers lag / missed deliveries.
 */
export async function ensureOwnerDefaultPaymentMethodIfMissing(
  ownerUserId: string,
): Promise<{ promoted: boolean; paymentMethodId: string | null }> {
  const trimmed = ownerUserId.trim();
  if (!trimmed) {
    return { promoted: false, paymentMethodId: null };
  }
  const chargeable = await ownerHasChargeablePaymentMethod(trimmed);
  if (chargeable === true) {
    return { promoted: false, paymentMethodId: null };
  }
  const methods = await listOwnerPaymentMethods(trimmed);
  const first = methods[0]?.id?.trim();
  if (!first) {
    return { promoted: false, paymentMethodId: null };
  }
  const result = await setOwnerDefaultPaymentMethod(trimmed, first);
  return {
    promoted: result.updated,
    paymentMethodId: result.paymentMethodId,
  };
}

/**
 * Same-origin Stripe return URL under `/billing` (or `/billing/…`).
 * Rejects open redirects; falls back when the candidate is missing/unsafe.
 * @internal Exported for unit tests.
 */
export function resolveOwnerBillingCheckoutReturnUrl(
  candidate: string | undefined,
  fallback: string,
): string {
  const raw = candidate?.trim();
  if (!raw) return fallback;
  try {
    const url = new URL(raw);
    const origin = new URL(getPublicOrigin());
    if (url.origin !== origin.origin) return fallback;
    const path = url.pathname;
    if (path !== "/billing" && !path.startsWith("/billing/")) {
      return fallback;
    }
    return url.toString();
  } catch {
    return fallback;
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
  const success = resolveOwnerBillingCheckoutReturnUrl(
    input.successUrl,
    `${origin}/billing?pm=attached`,
  );
  const cancel = resolveOwnerBillingCheckoutReturnUrl(
    input.cancelUrl,
    `${origin}/billing`,
  );

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
