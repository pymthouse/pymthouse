import { handleStripeWebhookPost } from "@/app/webhooks/stripe/handle-post";
import { resolveSandboxStripeWebhookSecretsByKind } from "@/lib/stripe/webhook";

export const runtime = "nodejs";

/**
 * Sandbox Stripe Connect / platform webhook endpoint.
 * Dashboard → sandbox account → Webhooks →
 *   POST {PUBLIC_ORIGIN}/webhooks/stripe/sandbox
 *
 * Secrets: STRIPE_SANDBOX_WEBHOOK_SECRET, STRIPE_SANDBOX_CONNECT_WEBHOOK_SECRET.
 * Owner top-ups are never granted on this plane. Merchant Connect top-ups
 * grant onto the sandbox payer (`sbx_eu_…`) when the app's stripeLivemode
 * is false. Events still restore payment methods and drive settlement collect.
 */
export async function POST(request: Request): Promise<Response> {
  return handleStripeWebhookPost(
    request,
    resolveSandboxStripeWebhookSecretsByKind,
    false,
  );
}
