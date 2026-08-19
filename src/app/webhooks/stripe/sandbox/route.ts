import { handleStripeWebhookPost } from "@/app/webhooks/stripe/handle-post";
import { resolveSandboxStripeWebhookSecretsByKind } from "@/lib/stripe/webhook";

export const runtime = "nodejs";

/**
 * Sandbox Stripe Connect / platform webhook endpoint.
 * Dashboard → sandbox account → Webhooks →
 *   POST {PUBLIC_ORIGIN}/webhooks/stripe/sandbox
 *
 * Secrets: STRIPE_SANDBOX_WEBHOOK_SECRET, STRIPE_SANDBOX_CONNECT_WEBHOOK_SECRET.
 * Owner Plane A grants are ignored on this route; merchant Connect events
 * still restore payment methods and settle end-user top-ups.
 */
export async function POST(request: Request): Promise<Response> {
  return handleStripeWebhookPost(
    request,
    resolveSandboxStripeWebhookSecretsByKind,
    false,
  );
}
