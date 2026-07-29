import { NextResponse } from "next/server";
import { applyConnectedAccountWebhookUpdate } from "@/lib/stripe/merchant-connect";
import {
  parseStripeAccountUpdated,
  requireStripeWebhookSecret,
  verifyStripeWebhookSignature,
} from "@/lib/stripe/webhook";
import { sanitizeForLog } from "@/lib/sanitize-for-log";

export const runtime = "nodejs";

/**
 * Stripe Connect platform webhook.
 * Configure in Dashboard → Developers → Webhooks (Connect events):
 *   POST {PUBLIC_ORIGIN}/webhooks/stripe
 * Subscribe at least to `account.updated`.
 */
export async function POST(request: Request): Promise<Response> {
  const tag = "[stripe-webhook]";
  let secret: string;
  try {
    secret = requireStripeWebhookSecret();
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

  if (type !== "account.updated") {
    return NextResponse.json({ received: true, ignored: type || "unknown" });
  }

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
