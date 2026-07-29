/**
 * Stripe Connected Accounts helpers for merchant billing (hybrid: OM meters, Connect charges).
 * Uses platform STRIPE_SECRET_KEY. Direct charges on acct_… with optional application fee.
 */
import { getPublicOrigin } from "@/lib/oidc/issuer-urls";

export type StripeOnboardingMethod = "account_link" | "oauth";

export type ConnectedAccountStatus = {
  id: string;
  chargesEnabled: boolean;
  payoutsEnabled: boolean;
  detailsSubmitted: boolean;
};

function requireStripeSecretKey(): string {
  const key =
    process.env.STRIPE_SECRET_KEY?.trim() || process.env.STRIPE_API_KEY?.trim();
  if (!key || !key.startsWith("sk_")) {
    throw new Error(
      "STRIPE_SECRET_KEY is required for Stripe Connect (must be sk_… platform key)",
    );
  }
  return key;
}

function requireConnectClientId(): string {
  const id = process.env.STRIPE_CONNECT_CLIENT_ID?.trim();
  if (!id) {
    throw new Error(
      "STRIPE_CONNECT_CLIENT_ID is required to link an existing Stripe account via OAuth",
    );
  }
  return id;
}

async function stripeFormRequest<T>(input: {
  method: string;
  path: string;
  body?: URLSearchParams;
  stripeAccount?: string;
  stripeVersion?: string;
  idempotencyKey?: string;
}): Promise<T> {
  const apiKey = requireStripeSecretKey();
  const headers: Record<string, string> = {
    Authorization: `Bearer ${apiKey}`,
    "Content-Type": "application/x-www-form-urlencoded",
  };
  if (input.stripeAccount) {
    headers["Stripe-Account"] = input.stripeAccount;
  }
  if (input.stripeVersion) {
    headers["Stripe-Version"] = input.stripeVersion;
  }
  if (input.idempotencyKey?.trim()) {
    headers["Idempotency-Key"] = input.idempotencyKey.trim();
  }
  const response = await fetch(`https://api.stripe.com${input.path}`, {
    method: input.method,
    headers,
    body: input.body?.toString(),
    signal: AbortSignal.timeout(30_000),
  });
  let json: T & { error?: { message?: string } };
  try {
    json = (await response.json()) as T & { error?: { message?: string } };
  } catch {
    throw new Error(
      `Stripe ${input.method} ${input.path} failed (${response.status}): non-JSON body`,
    );
  }
  if (!response.ok) {
    throw new Error(
      `Stripe ${input.method} ${input.path} failed (${response.status}): ${
        json.error?.message ?? JSON.stringify(json)
      }`,
    );
  }
  return json;
}

async function stripeJsonRequest<T>(input: {
  method: string;
  path: string;
  body?: unknown;
  stripeVersion: string;
}): Promise<T> {
  const apiKey = requireStripeSecretKey();
  const response = await fetch(`https://api.stripe.com${input.path}`, {
    method: input.method,
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      "Stripe-Version": input.stripeVersion,
    },
    body: input.body === undefined ? undefined : JSON.stringify(input.body),
    signal: AbortSignal.timeout(30_000),
  });
  let json: T & { error?: { message?: string } };
  try {
    json = (await response.json()) as T & { error?: { message?: string } };
  } catch {
    throw new Error(
      `Stripe ${input.method} ${input.path} failed (${response.status}): non-JSON body`,
    );
  }
  if (!response.ok) {
    throw new Error(
      `Stripe ${input.method} ${input.path} failed (${response.status}): ${
        json.error?.message ?? JSON.stringify(json)
      }`,
    );
  }
  return json;
}

/** Application fee in cents for a charge amount in cents. */
export function applicationFeeAmountCents(input: {
  amountCents: number;
  applicationFeeBps: number;
}): number {
  if (input.amountCents <= 0 || input.applicationFeeBps <= 0) {
    return 0;
  }
  return Math.floor((input.amountCents * input.applicationFeeBps) / 10_000);
}

/**
 * Create a merchant Connected Account.
 * Tries Accounts v2 merchant config; falls back to Express (v1) if v2 is unavailable.
 */
export async function createMerchantConnectedAccount(input: {
  clientId: string;
  email?: string;
  country?: string;
  displayName?: string;
}): Promise<string> {
  const country = (input.country ?? "US").toUpperCase();
  const email = input.email?.trim();
  const displayName = input.displayName?.trim() || `PymtHouse ${input.clientId}`;

  try {
    const created = await stripeJsonRequest<{ id?: string }>({
      method: "POST",
      path: "/v2/core/accounts",
      stripeVersion: "2025-03-31.preview",
      body: {
        contact_email: email || undefined,
        display_name: displayName,
        dashboard: "full",
        identity: {
          country: country.toLowerCase(),
        },
        configuration: {
          merchant: {
            capabilities: {
              card_payments: { requested: true },
              stripe_balance: {
                payouts: { requested: true },
              },
            },
          },
        },
        defaults: {
          currency: "usd",
          responsibilities: {
            fees_collector: "application",
            losses_collector: "application",
          },
        },
        metadata: {
          pymthouse_client_id: input.clientId,
        },
        include: ["configuration.merchant", "identity", "requirements"],
      },
    });
    if (created.id?.startsWith("acct_")) {
      return created.id;
    }
  } catch {
    // Fall through to Express v1 — widely available on Connect platforms.
  }

  const body = new URLSearchParams();
  body.set("type", "express");
  body.set("country", country);
  body.set("capabilities[card_payments][requested]", "true");
  body.set("capabilities[transfers][requested]", "true");
  body.set("metadata[pymthouse_client_id]", input.clientId);
  if (email) {
    body.set("email", email);
  }
  if (displayName) {
    body.set("business_profile[name]", displayName);
  }
  const account = await stripeFormRequest<{ id?: string }>({
    method: "POST",
    path: "/v1/accounts",
    body,
  });
  if (!account.id?.startsWith("acct_")) {
    throw new Error("Stripe did not return a Connected Account id");
  }
  return account.id;
}

export async function createAccountOnboardingLink(input: {
  accountId: string;
  refreshUrl: string;
  returnUrl: string;
}): Promise<string> {
  const body = new URLSearchParams();
  body.set("account", input.accountId);
  body.set("refresh_url", input.refreshUrl);
  body.set("return_url", input.returnUrl);
  body.set("type", "account_onboarding");
  const link = await stripeFormRequest<{ url?: string }>({
    method: "POST",
    path: "/v1/account_links",
    body,
  });
  if (!link.url) {
    throw new Error("Stripe Account Link URL unavailable");
  }
  return link.url;
}

export async function refreshConnectedAccountStatus(
  accountId: string,
): Promise<ConnectedAccountStatus> {
  const account = await stripeFormRequest<{
    id: string;
    charges_enabled?: boolean;
    payouts_enabled?: boolean;
    details_submitted?: boolean;
  }>({
    method: "GET",
    path: `/v1/accounts/${encodeURIComponent(accountId)}`,
  });
  return {
    id: account.id,
    chargesEnabled: Boolean(account.charges_enabled),
    payoutsEnabled: Boolean(account.payouts_enabled),
    detailsSubmitted: Boolean(account.details_submitted),
  };
}

export function buildConnectOAuthAuthorizeUrl(input: {
  state: string;
  redirectUri: string;
}): string {
  const clientId = requireConnectClientId();
  const url = new URL("https://connect.stripe.com/oauth/authorize");
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("scope", "read_write");
  url.searchParams.set("state", input.state);
  url.searchParams.set("redirect_uri", input.redirectUri);
  return url.toString();
}

export async function exchangeConnectOAuthCode(code: string): Promise<string> {
  const body = new URLSearchParams();
  body.set("client_secret", requireStripeSecretKey());
  body.set("code", code);
  body.set("grant_type", "authorization_code");
  const result = await stripeFormRequest<{
    stripe_user_id?: string;
  }>({
    method: "POST",
    path: "/v1/oauth/token",
    body,
  });
  const accountId = result.stripe_user_id?.trim();
  if (!accountId?.startsWith("acct_")) {
    throw new Error("Stripe OAuth did not return stripe_user_id");
  }
  return accountId;
}

export async function createConnectedCustomer(input: {
  accountId: string;
  name?: string;
  email?: string;
  metadata?: Record<string, string>;
}): Promise<string> {
  const body = new URLSearchParams();
  if (input.name?.trim()) {
    body.set("name", input.name.trim());
  }
  if (input.email?.trim()) {
    body.set("email", input.email.trim());
  }
  for (const [key, value] of Object.entries(input.metadata ?? {})) {
    body.set(`metadata[${key}]`, value);
  }
  const customer = await stripeFormRequest<{ id?: string }>({
    method: "POST",
    path: "/v1/customers",
    body,
    stripeAccount: input.accountId,
  });
  if (!customer.id?.startsWith("cus_")) {
    throw new Error("Stripe did not return a customer id on Connected Account");
  }
  return customer.id;
}

export async function createConnectedCheckoutSession(input: {
  accountId: string;
  customerId: string;
  successUrl: string;
  cancelUrl: string;
  applicationFeeBps?: number;
  /** Optional one-time line for fee preview; setup mode collects PM only. */
  mode?: "setup" | "payment";
  amountCents?: number;
  currency?: string;
  productName?: string;
  metadata?: Record<string, string>;
}): Promise<{ url: string; sessionId: string }> {
  const body = new URLSearchParams();
  const mode = input.mode ?? "setup";
  body.set("mode", mode);
  body.set("customer", input.customerId);
  body.set("success_url", input.successUrl);
  body.set("cancel_url", input.cancelUrl);
  if (mode === "setup") {
    body.set("payment_method_types[0]", "card");
  } else {
    const amount = input.amountCents;
    if (typeof amount !== "number" || !Number.isInteger(amount) || amount <= 0) {
      throw new Error("amountCents must be a positive integer for payment mode");
    }
    body.set("line_items[0][price_data][currency]", (input.currency ?? "usd").toLowerCase());
    body.set("line_items[0][price_data][unit_amount]", String(amount));
    body.set(
      "line_items[0][price_data][product_data][name]",
      input.productName ?? "Subscription",
    );
    body.set("line_items[0][quantity]", "1");
    const fee = applicationFeeAmountCents({
      amountCents: amount,
      applicationFeeBps: input.applicationFeeBps ?? 0,
    });
    if (fee > 0) {
      body.set("payment_intent_data[application_fee_amount]", String(fee));
    }
  }
  for (const [key, value] of Object.entries(input.metadata ?? {})) {
    if (key.trim() && value.trim()) {
      body.set(`metadata[${key.trim()}]`, value.trim());
    }
  }
  const session = await stripeFormRequest<{ id?: string; url?: string }>({
    method: "POST",
    path: "/v1/checkout/sessions",
    body,
    stripeAccount: input.accountId,
  });
  if (!session.url || !session.id) {
    throw new Error("Stripe Checkout session unavailable on Connected Account");
  }
  return { url: session.url, sessionId: session.id };
}

export async function createConnectedInvoice(input: {
  accountId: string;
  customerId: string;
  amountCents: number;
  currency?: string;
  description?: string;
  applicationFeeBps?: number;
  autoAdvance?: boolean;
  idempotencyKey?: string;
}): Promise<{ invoiceId: string; hostedInvoiceUrl: string | null }> {
  const currency = (input.currency ?? "usd").toLowerCase();
  const idempotencyBase = input.idempotencyKey?.trim();
  const itemBody = new URLSearchParams();
  itemBody.set("customer", input.customerId);
  itemBody.set("amount", String(input.amountCents));
  itemBody.set("currency", currency);
  if (input.description?.trim()) {
    itemBody.set("description", input.description.trim());
  }
  const item = await stripeFormRequest<{ id?: string }>({
    method: "POST",
    path: "/v1/invoiceitems",
    body: itemBody,
    stripeAccount: input.accountId,
    idempotencyKey: idempotencyBase ? `${idempotencyBase}:item` : undefined,
  });

  const invoiceBody = new URLSearchParams();
  invoiceBody.set("customer", input.customerId);
  invoiceBody.set("auto_advance", String(input.autoAdvance ?? true));
  const collection = "charge_automatically";
  invoiceBody.set("collection_method", collection);
  const fee = applicationFeeAmountCents({
    amountCents: input.amountCents,
    applicationFeeBps: input.applicationFeeBps ?? 0,
  });
  if (fee > 0) {
    invoiceBody.set("application_fee_amount", String(fee));
  }
  try {
    const invoice = await stripeFormRequest<{
      id?: string;
      hosted_invoice_url?: string | null;
    }>({
      method: "POST",
      path: "/v1/invoices",
      body: invoiceBody,
      stripeAccount: input.accountId,
      idempotencyKey: idempotencyBase ? `${idempotencyBase}:invoice` : undefined,
    });
    if (!invoice.id) {
      throw new Error("Stripe invoice create failed on Connected Account");
    }
    return {
      invoiceId: invoice.id,
      hostedInvoiceUrl: invoice.hosted_invoice_url ?? null,
    };
  } catch (err) {
    if (item.id?.trim()) {
      try {
        await stripeFormRequest({
          method: "DELETE",
          path: `/v1/invoiceitems/${item.id.trim()}`,
          stripeAccount: input.accountId,
        });
      } catch {
        // Best-effort cleanup; surface the original invoice failure.
      }
    }
    throw err;
  }
}

export function connectAccountLinkUrls(clientId: string): {
  refreshUrl: string;
  returnUrl: string;
} {
  const origin = getPublicOrigin();
  const base = `${origin}/apps/${encodeURIComponent(clientId)}/settings?tab=payments`;
  return {
    refreshUrl: `${base}&connect=refresh`,
    returnUrl: `${base}&connected=1`,
  };
}

export function connectOAuthCallbackUrl(clientId: string): string {
  return `${getPublicOrigin()}/api/v1/apps/${encodeURIComponent(clientId)}/billing/stripe/oauth/callback`;
}
