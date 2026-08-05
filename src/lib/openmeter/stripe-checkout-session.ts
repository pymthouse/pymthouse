/**
 * Create a Stripe Checkout Session (setup mode) via OpenMeter / Konnect.
 *
 * Self-hosted OpenMeter: POST /api/v1/stripe/checkout/sessions (SDK).
 * Konnect: POST /customers/{id}/billing/stripe/checkout-sessions
 * (the OSS path 404s on us.api.konghq.com).
 */
import type { OpenMeter } from "@openmeter/sdk";
import { getHostedOpenMeterUrl } from "./constants";
import { konnectAdminFetch } from "./konnect-admin-client";
import { shouldUseKonnectRoutes } from "./route-mode";

export type StripeCheckoutSessionResult = {
  checkoutUrl: string;
  sessionId: string | null;
};

/** True when `url` is an https Stripe Checkout host (blocks open redirects). */
export function isStripeCheckoutUrl(url: string): boolean {
  return stripeCheckoutRedirectUrl(url) !== null;
}

/**
 * Returns a same-origin-safe Stripe Checkout URL, or null if the input is not
 * an https `checkout.stripe.com` URL. Rebuilds the URL from allowlisted parts
 * so callers do not pass a remote string straight into location.assign.
 *
 * Must preserve the `#` fragment — Stripe Checkout embeds session state there.
 */
export function stripeCheckoutRedirectUrl(url: string): string | null {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:") return null;
    const host = parsed.hostname.toLowerCase();
    if (host !== "checkout.stripe.com" && !host.endsWith(".checkout.stripe.com")) {
      return null;
    }
    return `https://${host}${parsed.pathname}${parsed.search}${parsed.hash}`;
  } catch {
    return null;
  }
}

type KonnectCheckoutSessionResponse = {
  url?: string;
  session_id?: string;
};

function isKonnectMode(): boolean {
  return shouldUseKonnectRoutes(
    getHostedOpenMeterUrl(),
    process.env.OPENMETER_API_KEY,
  );
}

async function createKonnectStripeCheckoutSession(input: {
  customerId: string;
  successUrl: string;
  cancelUrl: string;
  currency?: string;
}): Promise<StripeCheckoutSessionResult> {
  const body: {
    stripe_options: {
      success_url: string;
      cancel_url: string;
      currency?: string;
    };
  } = {
    stripe_options: {
      success_url: input.successUrl,
      cancel_url: input.cancelUrl,
    },
  };
  const currency = input.currency?.trim().toUpperCase();
  if (currency) {
    body.stripe_options.currency = currency;
  }

  const result = await konnectAdminFetch<KonnectCheckoutSessionResponse>(
    `/customers/${encodeURIComponent(input.customerId)}/billing/stripe/checkout-sessions`,
    {
      method: "POST",
      body: JSON.stringify(body),
    },
    "stripe-checkout-session",
  );

  const checkoutUrl = result.url?.trim();
  if (!checkoutUrl) {
    throw new Error("Stripe checkout session URL unavailable");
  }
  return {
    checkoutUrl,
    sessionId: result.session_id?.trim() || null,
  };
}

async function createSelfHostedStripeCheckoutSession(input: {
  client: OpenMeter;
  customerId: string;
  successUrl: string;
  cancelUrl: string;
  currency?: string;
}): Promise<StripeCheckoutSessionResult> {
  const options: {
    successURL: string;
    cancelURL: string;
    currency?: string;
  } = {
    successURL: input.successUrl,
    cancelURL: input.cancelUrl,
  };
  const currency = input.currency?.trim().toUpperCase();
  if (currency) {
    options.currency = currency;
  }

  const checkout = await input.client.apps.stripe.createCheckoutSession({
    customer: { id: input.customerId },
    options,
  });
  if (!checkout?.url) {
    throw new Error("Stripe checkout session URL unavailable");
  }
  return {
    checkoutUrl: checkout.url,
    sessionId: checkout.sessionId ?? null,
  };
}

/** Plane A: attach a payment method via OM/Konnect Stripe Checkout (setup). */
export async function createOpenMeterStripeCheckoutSession(input: {
  client: OpenMeter;
  customerId: string;
  successUrl: string;
  cancelUrl: string;
  currency?: string;
}): Promise<StripeCheckoutSessionResult> {
  const customerId = input.customerId.trim();
  if (!customerId) {
    throw new Error("customerId is required");
  }
  if (isKonnectMode()) {
    return createKonnectStripeCheckoutSession({
      customerId,
      successUrl: input.successUrl,
      cancelUrl: input.cancelUrl,
      currency: input.currency,
    });
  }
  return createSelfHostedStripeCheckoutSession({
    client: input.client,
    customerId,
    successUrl: input.successUrl,
    cancelUrl: input.cancelUrl,
    currency: input.currency,
  });
}
