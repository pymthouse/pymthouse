import { NextResponse } from "next/server";

import {
  restoreAppUserBillingProfileAfterPaymentMethodAttached,
  restoreAppUserBillingProfileForCheckoutSession,
} from "@/lib/openmeter/app-user-payment-method";
import { listOwnedPublicClientIds } from "@/lib/openmeter/customers";
import { grantAllowanceUsdMicros } from "@/lib/openmeter/grant-allowance";
import { sanitizeForLog } from "@/lib/sanitize-for-log";
import { applyConnectedAccountWebhookUpdate } from "@/lib/stripe/merchant-connect";
import {
  parseTopUpCheckoutSessionCompleted,
  topUpGrantIdempotencyKey,
} from "@/lib/stripe/topup-checkout";
import {
  parseStripeCompletedCheckoutSessionId,
  parseStripeAccountUpdated,
  parseStripePaymentMethodAttached,
  resolveStripeWebhookSecretsByKind,
  verifyStripeWebhookSignature,
  type StripeWebhookSecret,
  type StripeWebhookSecretKind,
} from "@/lib/stripe/webhook";

export const runtime = "nodejs";

const TAG = "[stripe-webhook]";

let topUpClientOwnedByOwnerForTests:
  | ((clientId: string, ownerUserId: string) => Promise<boolean>)
  | null = null;

/**
 * Test-only override for top-up ownership checks (Stripe webhook route).
 * Always `null` (inert) outside NODE_ENV=test.
 */
export function __setTopUpClientOwnedByOwnerForTests(
  fn: ((clientId: string, ownerUserId: string) => Promise<boolean>) | null,
): void {
  if (process.env.NODE_ENV !== "test") {
    throw new Error("__setTopUpClientOwnedByOwnerForTests is only available in test");
  }
  topUpClientOwnedByOwnerForTests = fn;
}

function logHandlerError(context: string, err: unknown): void {
  const message = err instanceof Error ? err.message : String(err);
  console.error(TAG, `${context} failed:`, sanitizeForLog(message));
}

async function topUpClientOwnedByOwner(
  clientId: string,
  ownerUserId: string,
): Promise<boolean> {
  if (topUpClientOwnedByOwnerForTests) {
    return topUpClientOwnedByOwnerForTests(clientId, ownerUserId);
  }
  const owned = await listOwnedPublicClientIds(ownerUserId);
  return owned.includes(clientId);
}

/** Which configured endpoint secret signed this delivery, if any. */
function verifyWebhookSecretKind(input: {
  secrets: StripeWebhookSecret[];
  rawBody: string;
  signatureHeader: string | null;
}): StripeWebhookSecretKind | null {
  for (const entry of input.secrets) {
    if (
      verifyStripeWebhookSignature({
        rawBody: input.rawBody,
        signatureHeader: input.signatureHeader,
        secret: entry.secret,
      })
    ) {
      return entry.kind;
    }
  }
  return null;
}

function stripeEventAccount(rawBody: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody) as unknown;
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") {
    return null;
  }
  const account = (parsed as { account?: unknown }).account;
  return typeof account === "string" && account.trim() ? account.trim() : null;
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

async function handleCheckoutSessionCompleted(
  rawBody: string,
  secretKind: StripeWebhookSecretKind,
): Promise<Response> {
  const topUp = parseTopUpCheckoutSessionCompleted(rawBody);
  if (topUp) {
    if (secretKind !== "platform") {
      return NextResponse.json({
        received: true,
        ignored: "topup_requires_platform_secret",
      });
    }
    if (stripeEventAccount(rawBody)) {
      return NextResponse.json({
        received: true,
        ignored: "connect_account_event",
      });
    }

    let owned: boolean;
    try {
      owned = await topUpClientOwnedByOwner(topUp.clientId, topUp.ownerUserId);
    } catch (err) {
      logHandlerError("top-up ownership", err);
      return NextResponse.json({ error: "handler_failed" }, { status: 500 });
    }
    if (!owned) {
      console.warn(
        TAG,
        "top-up ignored: clientId not owned by ownerUserId",
        sanitizeForLog(topUp.clientId),
        sanitizeForLog(topUp.ownerUserId),
      );
      return NextResponse.json({
        received: true,
        ignored: "client_not_owned_by_owner",
      });
    }

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

  // Setup-mode sessions, unpaid async payments, foreign metadata.
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
 * Top-up grants require verification with the platform webhook secret and a
 * platform (non-Connect) event — Connect-signed deliveries are ignored for
 * credit settlement even when the payload looks like a top-up.
 */
export async function POST(request: Request): Promise<Response> {
  let secrets: StripeWebhookSecret[];
  try {
    secrets = resolveStripeWebhookSecretsByKind();
  } catch (err) {
    logHandlerError("configuration", err);
    return NextResponse.json({ error: "webhook_misconfigured" }, { status: 503 });
  }

  const rawBody = await request.text();
  const signatureHeader = request.headers.get("stripe-signature");
  const secretKind = verifyWebhookSecretKind({
    secrets,
    rawBody,
    signatureHeader,
  });
  if (!secretKind) {
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
    return handleCheckoutSessionCompleted(rawBody, secretKind);
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
