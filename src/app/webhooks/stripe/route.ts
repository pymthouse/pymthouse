import { NextResponse } from "next/server";
import { insertInvoiceEvent } from "@/lib/invoicing/ledger";
import { applyConnectedAccountWebhookUpdate } from "@/lib/stripe/merchant-connect";
import {
  parseStripeAccountUpdated,
  requireStripeWebhookSecret,
  verifyStripeWebhookSignature,
} from "@/lib/stripe/webhook";
import { sanitizeForLog } from "@/lib/sanitize-for-log";

export const runtime = "nodejs";

/**
 * Stripe Connect platform webhook (events from connected accounts).
 * Configure in Dashboard → Developers → Webhooks (Connect endpoint):
 *   POST {PUBLIC_ORIGIN}/webhooks/stripe
 *
 * Subscribe at least to:
 *   account.updated
 *   payment_intent.succeeded
 *   payment_intent.payment_failed
 *   payment_intent.requires_action
 *   charge.dispute.created
 *   account.application.deauthorized
 *
 * Prefer STRIPE_CONNECT_WEBHOOK_SECRET when the Connect endpoint has its own
 * signing secret; falls back to STRIPE_WEBHOOK_SECRET.
 */
const LEDGER_EVENT_TYPES = new Set([
  "payment_intent.succeeded",
  "payment_intent.payment_failed",
  "payment_intent.requires_action",
  "charge.dispute.created",
  "account.application.deauthorized",
  "checkout.session.completed",
]);

function resolveConnectWebhookSecret(): string {
  const connectSecret = process.env.STRIPE_CONNECT_WEBHOOK_SECRET?.trim();
  if (connectSecret?.startsWith("whsec_")) {
    return connectSecret;
  }
  return requireStripeWebhookSecret();
}

function stripeEventId(parsed: unknown): string | null {
  if (!parsed || typeof parsed !== "object") {
    return null;
  }
  const id = (parsed as { id?: unknown }).id;
  return typeof id === "string" && id.startsWith("evt_") ? id : null;
}

export async function POST(request: Request): Promise<Response> {
  const tag = "[stripe-webhook]";
  let secret: string;
  try {
    secret = resolveConnectWebhookSecret();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(tag, "misconfigured:", sanitizeForLog(message));
    return NextResponse.json({ error: "webhook_misconfigured" }, { status: 503 });
  }

  const rawBody = await request.text();
  const signatureHeader = request.headers.get("stripe-signature");
  if (
    !verifyStripeWebhookSignature({
      rawBody,
      signatureHeader,
      secret,
    })
  ) {
    console.warn(tag, "signature rejected");
    return NextResponse.json({ error: "invalid_signature" }, { status: 401 });
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody) as unknown;
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }
  const type =
    parsed && typeof parsed === "object" && "type" in parsed
      ? String((parsed as { type?: unknown }).type ?? "")
      : "";

  if (type === "account.updated") {
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
      const message = err instanceof Error ? err.message : String(err);
      console.error(tag, "account.updated failed:", sanitizeForLog(message));
      return NextResponse.json({ error: "handler_failed" }, { status: 500 });
    }
  }

  if (!LEDGER_EVENT_TYPES.has(type)) {
    return NextResponse.json({ received: true, ignored: type || "unknown" });
  }

  const eventId = stripeEventId(parsed);
  if (!eventId) {
    return NextResponse.json({ received: true, ignored: "missing_event_id" });
  }

  try {
    const result = await insertInvoiceEvent({
      source: "stripe",
      externalEventId: eventId,
      eventType: type,
      payload: parsed,
    });
    return NextResponse.json({
      received: true,
      inserted: result.inserted,
      id: result.id,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(tag, "ledger insert failed:", sanitizeForLog(message));
    return NextResponse.json({ error: "handler_failed" }, { status: 500 });
  }
}
