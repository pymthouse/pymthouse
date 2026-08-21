import { handleStripeWebhookPost } from "@/app/webhooks/stripe/handle-post";
import { resolveStripeWebhookSecretsByKind } from "@/lib/stripe/webhook";

export const runtime = "nodejs";

export async function POST(request: Request): Promise<Response> {
  return handleStripeWebhookPost(request, resolveStripeWebhookSecretsByKind);
}
