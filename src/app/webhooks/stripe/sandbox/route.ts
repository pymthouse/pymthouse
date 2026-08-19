import { handleStripeWebhookPost } from "@/app/webhooks/stripe/handle-post";
import { resolveSandboxStripeWebhookSecretsByKind } from "@/lib/stripe/webhook";

export const runtime = "nodejs";

/**
 * Sandbox Stripe Connect / platform webhook endpoint.
 * Dashboard → sandbox account → Webhooks →
 *   POST {PUBLIC_ORIGIN}/webhooks/stripe/sandbox
 *
 * Secrets: STRIPE_SANDBOX_WEBHOOK_SECRET, STRIPE_SANDBOX_CONNECT_WEBHOOK_SECRET.
 * This route never grants Konnect prepaid credits (owner or merchant).
 * Merchant Connect events still restore payment methods and drive Stripe
 * settlement collect; they do not mint production usd_credits.
 */
export async function POST(request: Request): Promise<Response> {
  return handleStripeWebhookPost(
    request,
    resolveSandboxStripeWebhookSecretsByKind,
    false,
  );
}
