import type { OpenMeter } from "@openmeter/sdk";
import { getHostedOpenMeterUrl } from "./constants";
import { konnectAdminFetch } from "./konnect-admin-client";
import { shouldUseKonnectRoutes } from "./route-mode";

type KonnectCustomerBillingData = {
  billing_profile?: { id?: string };
  app_data?: {
    stripe?: {
      customer_id?: string;
      default_payment_method_id?: string;
    };
  };
};

function requireStripeSecretKey(): string {
  const key =
    process.env.STRIPE_SECRET_KEY?.trim() || process.env.STRIPE_API_KEY?.trim();
  if (!key || !key.startsWith("sk_")) {
    throw new Error(
      "STRIPE_SECRET_KEY is required to provision Stripe customer data " +
        "(must be sk_… for the same Stripe account installed in Konnect/OpenMeter).",
    );
  }
  return key;
}

function isKonnectMode(): boolean {
  return shouldUseKonnectRoutes(
    getHostedOpenMeterUrl(),
    process.env.OPENMETER_API_KEY,
  );
}

async function createStripeCustomer(input: {
  openmeterCustomerId: string;
  customerKey?: string;
  name?: string;
}): Promise<string> {
  const apiKey = requireStripeSecretKey();
  const body = new URLSearchParams();
  body.set("metadata[openmeter_customer_id]", input.openmeterCustomerId);
  if (input.customerKey) {
    body.set("metadata[customer_key]", input.customerKey);
  }
  if (input.name?.trim()) {
    body.set("name", input.name.trim());
  }

  const response = await fetch("https://api.stripe.com/v1/customers", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body,
  });
  const json = (await response.json()) as {
    id?: string;
    error?: { message?: string };
  };
  if (!response.ok || !json.id) {
    throw new Error(
      `Stripe customer create failed (${response.status}): ${
        json.error?.message ?? JSON.stringify(json)
      }`,
    );
  }
  return json.id;
}

async function getKonnectCustomerBilling(
  customerId: string,
  signal?: AbortSignal,
): Promise<KonnectCustomerBillingData> {
  try {
    return await konnectAdminFetch<KonnectCustomerBillingData>(
      `/customers/${encodeURIComponent(customerId)}/billing`,
      { method: "GET", signal },
      "customer-billing",
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (/\(404\)/.test(message)) {
      return {};
    }
    throw err;
  }
}

async function getKonnectStripeCustomerId(
  customerId: string,
): Promise<string | null> {
  const data = await getKonnectCustomerBilling(customerId);
  const id = data.app_data?.stripe?.customer_id?.trim();
  return id || null;
}

/**
 * Konnect drops `app_data.stripe` when a customer moves to a profile without the
 * Stripe app (the free/Starter profile), so the `cus_…` is also mirrored into
 * customer metadata. Re-provisioning reads it back from there instead of creating
 * a duplicate Stripe customer.
 */
const STRIPE_CUSTOMER_LABEL_KEY = "pymthouse_stripe_customer_id";

/**
 * Konnect stores customer key/value data in `labels`; a `metadata` field is
 * accepted and silently discarded.
 */
type KonnectCustomerRecord = {
  name?: string;
  labels?: Record<string, string>;
  usage_attribution?: { subject_keys?: string[] };
};

async function getKonnectCustomer(
  customerId: string,
): Promise<KonnectCustomerRecord | null> {
  try {
    return await konnectAdminFetch<KonnectCustomerRecord>(
      `/customers/${encodeURIComponent(customerId)}`,
      { method: "GET" },
      "customer",
    );
  } catch {
    return null;
  }
}

async function recallStripeCustomerId(customerId: string): Promise<string | null> {
  const customer = await getKonnectCustomer(customerId);
  return customer?.labels?.[STRIPE_CUSTOMER_LABEL_KEY]?.trim() || null;
}

async function rememberStripeCustomerId(input: {
  customerId: string;
  stripeCustomerId: string;
}): Promise<void> {
  try {
    const customer = await getKonnectCustomer(input.customerId);
    if (!customer) {
      throw new Error(`customer ${input.customerId} not readable`);
    }
    if (
      customer.labels?.[STRIPE_CUSTOMER_LABEL_KEY]?.trim() ===
      input.stripeCustomerId
    ) {
      return;
    }
    // The customer PUT is a full replace and expects snake_case: sending
    // camelCase `usageAttribution` is ignored and wipes the subject keys, which
    // then cannot be restored while a subscription is active. Echo the existing
    // keys back unchanged so the active-subscription guard does not trip either.
    await konnectAdminFetch(
      `/customers/${encodeURIComponent(input.customerId)}`,
      {
        method: "PUT",
        body: JSON.stringify({
          name: customer.name,
          usage_attribution: {
            subject_keys: customer.usage_attribution?.subject_keys ?? [],
          },
          labels: {
            ...(customer.labels ?? {}),
            [STRIPE_CUSTOMER_LABEL_KEY]: input.stripeCustomerId,
          },
        }),
      },
      "customer",
    );
  } catch (err) {
    // The Stripe pointer in app_data is already written; losing the mirror only
    // costs us a duplicate customer on a later profile move.
    console.warn("openmeter: failed to mirror Stripe customer id into labels", {
      customerId: input.customerId,
      error: err instanceof Error ? err.message : err,
    });
  }
}

/**
 * Konnect persists Stripe app data via PUT /customers/{id}/billing (with app_data),
 * not PUT …/billing/app-data (returns 200 but leaves app_data empty).
 */
async function upsertKonnectCustomerBilling(input: {
  customerId: string;
  stripeCustomerId: string;
  billingProfileId?: string;
  /** `null` drops the stored pointer; omit it to carry the existing one forward. */
  defaultPaymentMethodId?: string | null;
}): Promise<KonnectCustomerBillingData> {
  const existing = await getKonnectCustomerBilling(input.customerId);
  const profileId =
    input.billingProfileId?.trim() || existing.billing_profile?.id?.trim();
  // The PUT replaces app_data.stripe wholesale, so carry the existing default
  // pointer forward when the caller is not changing it.
  const defaultPaymentMethodId =
    input.defaultPaymentMethodId === null
      ? undefined
      : input.defaultPaymentMethodId?.trim() ||
        existing.app_data?.stripe?.default_payment_method_id?.trim();
  const stripe: { customer_id: string; default_payment_method_id?: string } = {
    customer_id: input.stripeCustomerId,
  };
  if (defaultPaymentMethodId) {
    stripe.default_payment_method_id = defaultPaymentMethodId;
  }
  const body: {
    app_data: { stripe: typeof stripe };
    billing_profile?: { id: string };
  } = {
    app_data: { stripe },
  };
  if (profileId) {
    body.billing_profile = { id: profileId };
  }
  return konnectAdminFetch<KonnectCustomerBillingData>(
    `/customers/${encodeURIComponent(input.customerId)}/billing`,
    {
      method: "PUT",
      body: JSON.stringify(body),
    },
    "customer-billing",
  );
}

/**
 * Konnect: pin a customer to a billing profile without provisioning Stripe.
 * `billing.customers.createOverride` does not persist on Konnect, so profile
 * moves for Stripe-less (free / Starter) customers must go through this PUT.
 * The PUT replaces app_data wholesale, so an existing Stripe pointer is carried
 * forward; Konnect still drops it when the destination profile has no Stripe app
 * installed (moving to the sandbox/free profile), which is why an upgrade back
 * to a paid plan re-provisions the `cus_…`.
 */
export async function setKonnectCustomerBillingProfile(input: {
  customerId: string;
  billingProfileId: string;
}): Promise<void> {
  const existing = await getKonnectCustomerBilling(input.customerId);
  const stripe = existing.app_data?.stripe;
  const body: {
    billing_profile: { id: string };
    app_data?: { stripe: NonNullable<typeof stripe> };
  } = {
    billing_profile: { id: input.billingProfileId },
  };
  if (stripe?.customer_id?.trim()) {
    body.app_data = { stripe };
  }
  const written = await konnectAdminFetch<KonnectCustomerBillingData>(
    `/customers/${encodeURIComponent(input.customerId)}/billing`,
    {
      method: "PUT",
      body: JSON.stringify(body),
    },
    "customer-billing",
  );
  const profile = written.billing_profile?.id?.trim();
  if (profile !== input.billingProfileId) {
    throw new Error(
      `Konnect billing profile mismatch for ${input.customerId}: expected ${input.billingProfileId}, got ${profile ?? "none"}`,
    );
  }
}

/**
 * Point Konnect app_data at a new default payment method so OpenMeter
 * invoicing charges the method the owner picked. No-op outside Konnect mode.
 */
export async function setKonnectStripeDefaultPaymentMethod(input: {
  customerId: string;
  stripeCustomerId: string;
  paymentMethodId: string;
}): Promise<void> {
  if (!isKonnectMode()) {
    return;
  }
  await upsertKonnectCustomerBilling({
    customerId: input.customerId,
    stripeCustomerId: input.stripeCustomerId,
    defaultPaymentMethodId: input.paymentMethodId,
  });
}

/**
 * Drop the Konnect app_data pointer so OpenMeter invoicing stops charging a
 * payment method that is no longer attached. No-op outside Konnect mode.
 */
export async function clearKonnectStripeDefaultPaymentMethod(input: {
  customerId: string;
  stripeCustomerId: string;
}): Promise<void> {
  if (!isKonnectMode()) {
    return;
  }
  await upsertKonnectCustomerBilling({
    customerId: input.customerId,
    stripeCustomerId: input.stripeCustomerId,
    defaultPaymentMethodId: null,
  });
}

async function getSelfHostedStripeCustomerId(
  client: OpenMeter,
  customerId: string,
): Promise<string | null> {
  try {
    const data = await client.customers.stripe.get(customerId);
    const id = data?.stripeCustomerId?.trim();
    return id || null;
  } catch {
    return null;
  }
}

async function upsertSelfHostedStripeCustomerId(input: {
  client: OpenMeter;
  customerId: string;
  stripeCustomerId: string;
}): Promise<void> {
  await input.client.customers.stripe.upsert(input.customerId, {
    stripeCustomerId: input.stripeCustomerId,
  });
}

/**
 * Ensure the OpenMeter/Konnect customer has Stripe app data (`cus_…`).
 * Does not require a payment method — Starter included usage works without a card.
 */
export async function ensureStripeCustomerAppData(input: {
  client: OpenMeter;
  customerId: string;
  customerKey?: string;
  name?: string;
  /** When set on Konnect, written together with stripe app data (required for persistence). */
  billingProfileId?: string;
}): Promise<string> {
  if (isKonnectMode()) {
    const existing = await getKonnectStripeCustomerId(input.customerId);
    if (existing && !input.billingProfileId?.trim()) {
      return existing;
    }
    if (!input.billingProfileId?.trim()) {
      throw new Error(
        "Konnect requires a Stripe billing profile id to persist customer Stripe app data " +
          "(PUT /billing/app-data is a no-op; use ensureKonnectCustomerStripeBilling).",
      );
    }
    return ensureKonnectCustomerStripeBilling({
      customerId: input.customerId,
      customerKey: input.customerKey,
      name: input.name,
      billingProfileId: input.billingProfileId,
    });
  }

  const existing = await getSelfHostedStripeCustomerId(
    input.client,
    input.customerId,
  );
  if (existing) {
    return existing;
  }
  const stripeCustomerId = await createStripeCustomer({
    openmeterCustomerId: input.customerId,
    customerKey: input.customerKey,
    name: input.name,
  });
  await upsertSelfHostedStripeCustomerId({
    client: input.client,
    customerId: input.customerId,
    stripeCustomerId,
  });
  return stripeCustomerId;
}

/**
 * Konnect: set Stripe cus_… and billing profile in one PUT /billing call.
 * Prefer this over separate app-data + createOverride (app-data endpoint is a no-op).
 */
export async function ensureKonnectCustomerStripeBilling(input: {
  customerId: string;
  customerKey?: string;
  name?: string;
  billingProfileId: string;
}): Promise<string> {
  // app_data first (cheapest, and authoritative while it is present), then the
  // label mirror, so a customer returning from the free profile keeps its
  // original Stripe customer instead of orphaning it behind a new one.
  const stripeCustomerId =
    (await getKonnectStripeCustomerId(input.customerId)) ||
    (await recallStripeCustomerId(input.customerId)) ||
    (await createStripeCustomer({
      openmeterCustomerId: input.customerId,
      customerKey: input.customerKey,
      name: input.name,
    }));
  const written = await upsertKonnectCustomerBilling({
    customerId: input.customerId,
    stripeCustomerId,
    billingProfileId: input.billingProfileId,
  });
  const persisted = written.app_data?.stripe?.customer_id?.trim();
  if (!persisted) {
    throw new Error(
      `Konnect did not persist Stripe customer app data for ${input.customerId}`,
    );
  }
  const profile = written.billing_profile?.id?.trim();
  if (profile !== input.billingProfileId) {
    throw new Error(
      `Konnect billing profile mismatch for ${input.customerId}: expected ${input.billingProfileId}, got ${profile ?? "none"}`,
    );
  }
  await rememberStripeCustomerId({
    customerId: input.customerId,
    stripeCustomerId: persisted,
  });
  return persisted;
}

/** Read-only helper for audits/migrations. */
export async function getStripeCustomerAppDataId(input: {
  client: OpenMeter;
  customerId: string;
}): Promise<string | null> {
  if (isKonnectMode()) {
    return getKonnectStripeCustomerId(input.customerId);
  }
  return getSelfHostedStripeCustomerId(input.client, input.customerId);
}

export async function getKonnectCustomerBillingProfileId(
  customerId: string,
): Promise<string | null> {
  if (!isKonnectMode()) {
    return null;
  }
  try {
    const data = await getKonnectCustomerBilling(customerId);
    return data.billing_profile?.id?.trim() || null;
  } catch {
    return null;
  }
}

/** Stripe default payment method id from Konnect customer billing app_data, if any. */
export async function getKonnectDefaultPaymentMethodId(
  customerId: string,
): Promise<string | null> {
  return (await getKonnectStripeBillingRefs(customerId)).defaultPaymentMethodId;
}

export type KonnectStripeBillingRefs = {
  stripeCustomerId: string | null;
  defaultPaymentMethodId: string | null;
};

/**
 * Both Stripe ids from a single Konnect /billing read. Callers that need the
 * customer and its default payment method must use this rather than pairing
 * getKonnectStripeCustomerId + getKonnectDefaultPaymentMethodId, which fetch
 * the same uncached document twice.
 */
export async function getKonnectStripeBillingRefs(
  customerId: string,
  signal?: AbortSignal,
): Promise<KonnectStripeBillingRefs> {
  if (!isKonnectMode()) {
    return { stripeCustomerId: null, defaultPaymentMethodId: null };
  }
  try {
    const data = await getKonnectCustomerBilling(customerId, signal);
    const stripe = data.app_data?.stripe;
    return {
      stripeCustomerId: stripe?.customer_id?.trim() || null,
      defaultPaymentMethodId:
        stripe?.default_payment_method_id?.trim() || null,
    };
  } catch {
    return { stripeCustomerId: null, defaultPaymentMethodId: null };
  }
}
