import { handleStripeWebhookPost } from "@/app/webhooks/stripe/handle-post";
import { resolveSandboxStripeWebhookSecretsByKind } from "@/lib/stripe/webhook";

export const runtime = "nodejs";

/**
 * Sandbox Stripe Connect / platform webhook endpoint.
 * Dashboard → sandbox account → Webhooks →
 *   POST {PUBLIC_ORIGIN}/webhooks/stripe/sandbox
 *
 * Secrets: STRIPE_SANDBOX_WEBHOOK_SECRET, STRIPE_SANDBOX_CONNECT_WEBHOOK_SECRET.
 */
export async function POST(request: Request): Promise<Response> {
  return handleStripeWebhookPost(
    request,
    resolveSandboxStripeWebhookSecretsByKind,
  );
}
