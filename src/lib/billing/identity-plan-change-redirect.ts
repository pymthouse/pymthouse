import { stripeCheckoutRedirectUrl } from "@/lib/openmeter/stripe-checkout-session";

/**
 * Where to send the browser after POST …/subscription/change.
 *
 * Payment-method collection returns both `checkoutUrl` (Stripe Checkout) and
 * the *current* `subscriptionId` — /change has not run yet. Callers must not
 * treat a present subscriptionId as "already switched; skip Checkout".
 */
export function identityPlanChangeCheckoutRedirectUrl(body: {
  checkoutUrl?: string | null;
  subscriptionId?: string | null;
} | null | undefined): string | null {
  return stripeCheckoutRedirectUrl(body?.checkoutUrl?.trim() ?? "");
}
