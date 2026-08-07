import { NextResponse } from "next/server";
import {
  restoreAppUserBillingProfileAfterPaymentMethodAttached,
  restoreAppUserBillingProfileForCheckoutSession,
} from "@/lib/openmeter/app-user-payment-method";
import { grantAllowanceUsdMicros } from "@/lib/openmeter/grant-allowance";
import { applyConnectedAccountWebhookUpdate } from "@/lib/stripe/merchant-connect";
import {
  parseTopUpCheckoutSessionCompleted,
  topUpGrantIdempotencyKey,
} from "@/lib/stripe/topup-checkout";
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

function logHandlerError(context: string, err: unknown): void {
  const message = err instanceof Error ? err.message : String(err);
  console.error(TAG, `${context} failed:`, sanitizeForLog(message));
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
  try {
    const result = await applyConnectedAccountWebhookUpdate(account);
    return NextResponse.json({
      received: true,
      updated: result.updated,
      clientId: result.clientId ?? null,
    });
  } catch (err) {
    logHandlerError("account.updated", err);
    return NextResponse.json({ error: "handler_failed" }, { status: 500 });
  }
}

async function handleCheckoutSessionCompleted(rawBody: string): Promise<Response> {
  const topUp = parseTopUpCheckoutSessionCompleted(rawBody);
  if (topUp) {
    try {
      // The Checkout session id is the grant idempotency key — a Stripe retry
      // or duplicate delivery 409s inside Konnect and credits exactly once.
      await grantAllowanceUsdMicros({
        clientId: topUp.clientId,
        externalUserId: `owner:${topUp.ownerUserId}`,
        amountUsdMicros: topUp.amountUsdMicros,
        source: "topup",
        idempotencyKey: topUpGrantIdempotencyKey(topUp.sessionId),
      });
      return NextResponse.json({
        received: true,
        credited: true,
        sessionId: topUp.sessionId,
      });
    } catch (err) {
      logHandlerError("top-up settle", err);
      // 500 → Stripe retries; the idempotency key makes the retry safe.
      return NextResponse.json({ error: "handler_failed" }, { status: 500 });
    }
  }

  // Setup-mode / subscribe checkouts restore the app-user billing profile.
  try {
    const restored = await handlePaymentMethodRestore(rawBody);
    if (restored) {
      return restored;
    }
  } catch (err) {
    logHandlerError("payment method restore", err);
    return NextResponse.json({ error: "handler_failed" }, { status: 500 });
  }

  return NextResponse.json({ received: true, ignored: "not_a_topup" });
}

function eventTypeFromRawBody(rawBody: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody) as unknown;
  } catch {
    return null;
  }
  const rawType =
    parsed && typeof parsed === "object" && "type" in parsed
      ? (parsed as { type?: unknown }).type
      : undefined;
  return typeof rawType === "string" ? rawType : "";
}

/**
 * Stripe webhook for Connect account lifecycle (KYC / readiness), app-user
 * payment-method restore, and platform prepaid top-up settlement. Configure in
 * Dashboard → Developers → Webhooks:
 *   POST {PUBLIC_ORIGIN}/webhooks/stripe
 *
 * Subscribe at least to:
 *   account.updated                          (Connect endpoint)
 *   checkout.session.completed               (platform — top-ups / PM setup)
 *   checkout.session.async_payment_succeeded (platform — delayed top-ups)
 *   setup_intent.succeeded                   (Connect — app-user payment methods)
 *
 * PaymentIntent / charge / dispute events for Custom Invoicing settlement are
 * handled by pymthouse/settlement (Kafka producer), not this route.
 *
 * Each Stripe endpoint signs with its own secret, so verification accepts any
 * configured secret (STRIPE_CONNECT_WEBHOOK_SECRET and/or STRIPE_WEBHOOK_SECRET).
 */
export async function POST(request: Request): Promise<Response> {
  let secrets: string[];
  try {
    secrets = resolveStripeWebhookSecrets();
  } catch (err) {
    logHandlerError("configuration", err);
    return NextResponse.json({ error: "webhook_misconfigured" }, { status: 503 });
  }

  const rawBody = await request.text();
  const signatureHeader = request.headers.get("stripe-signature");
  const verified = secrets.some((secret) =>
    verifyStripeWebhookSignature({ rawBody, signatureHeader, secret }),
  );
  if (!verified) {
    console.warn(TAG, "signature rejected");
    return NextResponse.json({ error: "invalid_signature" }, { status: 401 });
  }

  const type = eventTypeFromRawBody(rawBody);
  if (type === null) {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }
  if (type === "account.updated") {
    return handleAccountUpdated(rawBody);
  }
  if (
    type === "checkout.session.completed" ||
    type === "checkout.session.async_payment_succeeded"
  ) {
    return handleCheckoutSessionCompleted(rawBody);
  }
  if (type === "setup_intent.succeeded") {
    try {
      const restored = await handlePaymentMethodRestore(rawBody);
      if (restored) {
        return restored;
      }
    } catch (err) {
      logHandlerError("payment method restore", err);
      return NextResponse.json({ error: "handler_failed" }, { status: 500 });
    }
  }
  return NextResponse.json({ received: true, ignored: type || "unknown" });
}
