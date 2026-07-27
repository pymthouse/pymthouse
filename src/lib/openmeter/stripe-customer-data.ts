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
): Promise<KonnectCustomerBillingData> {
  try {
    return await konnectAdminFetch<KonnectCustomerBillingData>(
      `/customers/${encodeURIComponent(customerId)}/billing`,
      { method: "GET" },
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
 * Konnect persists Stripe app data via PUT /customers/{id}/billing (with app_data),
 * not PUT …/billing/app-data (returns 200 but leaves app_data empty).
 */
async function upsertKonnectCustomerBilling(input: {
  customerId: string;
  stripeCustomerId: string;
  billingProfileId?: string;
}): Promise<KonnectCustomerBillingData> {
  const existing = await getKonnectCustomerBilling(input.customerId);
  const profileId =
    input.billingProfileId?.trim() || existing.billing_profile?.id?.trim();
  const body: {
    app_data: { stripe: { customer_id: string } };
    billing_profile?: { id: string };
  } = {
    app_data: { stripe: { customer_id: input.stripeCustomerId } },
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
  const existing = await getKonnectStripeCustomerId(input.customerId);
  const stripeCustomerId =
    existing ||
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
  if (!isKonnectMode()) {
    return null;
  }
  try {
    const data = await getKonnectCustomerBilling(customerId);
    return data.app_data?.stripe?.default_payment_method_id?.trim() || null;
  } catch {
    return null;
  }
}
