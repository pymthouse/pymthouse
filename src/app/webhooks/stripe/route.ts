import { NextResponse } from "next/server";
import {
  restoreAppUserBillingProfileAfterPaymentMethodAttached,
  restoreAppUserBillingProfileForCheckoutSession,
} from "@/lib/openmeter/app-user-payment-method";
import { applyConnectedAccountWebhookUpdate } from "@/lib/stripe/merchant-connect";
import {
  parseStripeCompletedCheckoutSessionId,
  parseStripeAccountUpdated,
  parseStripePaymentMethodAttached,
  resolveStripeWebhookSecrets,
  verifyStripeWebhookSignature,
} from "@/lib/stripe/webhook";
import { sanitizeForLog } from "@/lib/sanitize-for-log";

export const runtime = "nodejs";

const TAG = "[stripe-webhook]";

/**
 * Stripe Connect platform webhook for account lifecycle (KYC / readiness).
 * Configure in Dashboard → Developers → Webhooks (Connect endpoint):
 *   POST {PUBLIC_ORIGIN}/webhooks/stripe
 *
 * Subscribe at least to:
 *   account.updated
 *   checkout.session.completed
 *   setup_intent.succeeded
 *
 * PaymentIntent / charge / dispute events for Custom Invoicing settlement are
 * handled by pymthouse/settlement (Kafka producer), not this route.
 *
 * Prefer STRIPE_CONNECT_WEBHOOK_SECRET when the Connect endpoint has its own
 * signing secret; falls back to STRIPE_WEBHOOK_SECRET.
 */
function eventTypeFromBody(parsed: unknown): string {
  const rawType =
    parsed && typeof parsed === "object" && "type" in parsed
      ? (parsed as { type?: unknown }).type
      : undefined;
  return typeof rawType === "string" ? rawType : "";
}

async function handlePaymentMethodRestore(
  rawBody: string,
): Promise<Response | null> {
  const restoreTarget = parseStripePaymentMethodAttached(rawBody);
  if (restoreTarget) {
    await restoreAppUserBillingProfileAfterPaymentMethodAttached(restoreTarget);
    return NextResponse.json({
      received: true,
      restored: true,
      clientId: restoreTarget.clientId,
    });
  }

  const checkoutSessionId = parseStripeCompletedCheckoutSessionId(rawBody);
  if (!checkoutSessionId) {
    return null;
  }
  const restored =
    await restoreAppUserBillingProfileForCheckoutSession(checkoutSessionId);
  return NextResponse.json({ received: true, restored });
}

async function handleAccountUpdated(rawBody: string): Promise<Response> {
  const account = parseStripeAccountUpdated(rawBody);
  if (!account) {
    return NextResponse.json({ received: true, ignored: "malformed_account" });
  }
  const result = await applyConnectedAccountWebhookUpdate(account);
  return NextResponse.json({
    received: true,
    updated: result.updated,
    clientId: result.clientId ?? null,
  });
}

function handlerFailed(err: unknown, label: string): Response {
  const message = err instanceof Error ? err.message : String(err);
  console.error(TAG, `${label} failed:`, sanitizeForLog(message));
  return NextResponse.json({ error: "handler_failed" }, { status: 500 });
}

export async function POST(request: Request): Promise<Response> {
  let secrets: string[];
  try {
    secrets = resolveStripeWebhookSecrets();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(TAG, "misconfigured:", sanitizeForLog(message));
    return NextResponse.json({ error: "webhook_misconfigured" }, { status: 503 });
  }

  const rawBody = await request.text();
  const signatureHeader = request.headers.get("stripe-signature");
  if (
    !secrets.some((secret) =>
      verifyStripeWebhookSignature({
        rawBody,
        signatureHeader,
        secret,
      }),
    )
  ) {
    console.warn(TAG, "signature rejected");
    return NextResponse.json({ error: "invalid_signature" }, { status: 401 });
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody) as unknown;
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }
  const type = eventTypeFromBody(parsed);

  try {
    const restored = await handlePaymentMethodRestore(rawBody);
    if (restored) {
      return restored;
    }
  } catch (err) {
    return handlerFailed(err, "payment method restore");
  }

  if (type === "account.updated") {
    try {
      return await handleAccountUpdated(rawBody);
    } catch (err) {
      return handlerFailed(err, "account.updated");
    }
  }

  return NextResponse.json({ received: true, ignored: type || "unknown" });
}
