import { timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { insertInvoiceEvent } from "@/lib/invoicing/ledger";
import { requireOpenMeterWebhookSecret } from "@/lib/openmeter/custom-invoicing";
import { sanitizeForLog } from "@/lib/sanitize-for-log";

export const runtime = "nodejs";

/**
 * OpenMeter / Konnect Invoice Notifications ingress.
 * Configure a webhook Channel with header X-Webhook-Secret (or Authorization Bearer).
 * @see https://developer.konghq.com/metering-and-billing/notifications/
 */
function secretsMatch(provided: string, expected: string): boolean {
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length) {
    return false;
  }
  return timingSafeEqual(a, b);
}

function extractProvidedSecret(request: Request): string | null {
  const headerSecret = request.headers.get("x-webhook-secret")?.trim();
  if (headerSecret) {
    return headerSecret;
  }
  const auth = request.headers.get("authorization")?.trim();
  if (auth?.toLowerCase().startsWith("bearer ")) {
    return auth.slice(7).trim();
  }
  return null;
}

function parseOpenMeterEvent(body: unknown): {
  eventId: string;
  eventType: string;
} | null {
  if (!body || typeof body !== "object") {
    return null;
  }
  const record = body as Record<string, unknown>;
  const eventId =
    (typeof record.id === "string" && record.id.trim()) ||
    (typeof record.eventId === "string" && record.eventId.trim()) ||
    "";
  const eventType =
    (typeof record.type === "string" && record.type.trim()) ||
    (typeof record.eventType === "string" && record.eventType.trim()) ||
    "unknown";
  if (!eventId) {
    return null;
  }
  return { eventId, eventType };
}

export async function POST(request: Request): Promise<Response> {
  const tag = "[openmeter-webhook]";
  let secret: string;
  try {
    secret = requireOpenMeterWebhookSecret();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(tag, "misconfigured:", sanitizeForLog(message));
    return NextResponse.json({ error: "webhook_misconfigured" }, { status: 503 });
  }

  const provided = extractProvidedSecret(request);
  if (!provided || !secretsMatch(provided, secret)) {
    console.warn(tag, "secret rejected");
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  let parsed: unknown;
  try {
    parsed = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }

  const event = parseOpenMeterEvent(parsed);
  if (!event) {
    return NextResponse.json({ error: "missing_event_id" }, { status: 400 });
  }

  try {
    const result = await insertInvoiceEvent({
      source: "openmeter",
      externalEventId: event.eventId,
      eventType: event.eventType,
      payload: parsed,
    });
    return NextResponse.json({
      received: true,
      inserted: result.inserted,
      id: result.id,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(tag, "insert failed:", sanitizeForLog(message));
    return NextResponse.json({ error: "handler_failed" }, { status: 500 });
  }
}
