import { NextRequest, NextResponse } from "next/server";
import { v4 as uuidv4 } from "uuid";
import { db } from "@/db/index";
import { usageIngestReceipts } from "@/db/schema";
import { getProviderApp } from "@/lib/provider-apps";
import { durableSignedTicketIngestEnabled } from "@/lib/billing/feature-flags";
import {
  ingestSignedTicketDurable,
  resolveNetworkFeeUsdMicros,
} from "@/lib/openmeter/signed-ticket-ingest";

type GatewayEventPayload = {
  type?: string;
  id?: string;
  data?: Record<string, unknown>;
};

function verifyIngestSecret(request: NextRequest): boolean {
  const expected = process.env.INGEST_SHARED_SECRET?.trim();
  if (!expected) {
    return process.env.NODE_ENV !== "production";
  }
  const auth = request.headers.get("authorization") || "";
  if (!auth.startsWith("Bearer ")) {
    return false;
  }
  return auth.slice(7).trim() === expected;
}

function pickString(data: Record<string, unknown>, ...keys: string[]): string {
  for (const key of keys) {
    const value = data[key];
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
    if (typeof value === "number" && Number.isFinite(value)) {
      return String(Math.trunc(value));
    }
  }
  return "";
}

function optionalString(value: string): string | undefined {
  return value ? value : undefined;
}

/**
 * Synchronous ingest of `create_signed_ticket` usage events from the go-livepeer
 * remote signer.
 *
 * Default (flag OFF, `SIGNED_TICKET_DURABLE_INGEST` unset): diagnostic-only —
 * records a receipt and returns `ingested:false`. OpenMeter is fed exclusively by
 * the legacy Kafka → Benthos `openmeter-collector` pipeline, so behavior is
 * unchanged.
 *
 * Flag ON: durable, idempotent, acked path — synchronously writes the CloudEvent
 * to OpenMeter and returns `ingested:true` only after the write is accepted.
 * Deduped on `(clientId, requestId)` (and OpenMeter's CloudEvent-id dedupe), so
 * it is safe to run alongside the legacy Kafka path during rollout.
 */
export async function POST(request: NextRequest) {
  if (!verifyIngestSecret(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const payload: Record<string, unknown> =
    typeof body === "object" && body !== null && !Array.isArray(body)
      ? (body as Record<string, unknown>)
      : {};
  const gatewayPayload = payload as GatewayEventPayload;
  const data =
    gatewayPayload.data && typeof gatewayPayload.data === "object"
      ? gatewayPayload.data
      : payload;

  const eventType = pickString(payload, "type") || "create_signed_ticket";
  if (eventType !== "create_signed_ticket") {
    return NextResponse.json({ error: "Unsupported event type" }, { status: 400 });
  }

  const clientId = pickString(data, "client_id");
  const externalUserId = pickString(data, "usage_subject", "external_user_id");
  const requestId = pickString(data, "request_id") || pickString(payload, "id");

  if (!clientId || !externalUserId || !requestId) {
    return NextResponse.json(
      { error: "client_id, usage_subject, and request_id are required" },
      { status: 400 },
    );
  }

  if (durableSignedTicketIngestEnabled()) {
    const computedFeeWei = pickString(data, "computed_fee_wei", "computed_fee");
    const networkFeeUsdMicros = resolveNetworkFeeUsdMicros({
      computedFeeUsdMicros: pickString(data, "computed_fee_usd_micros"),
      computedFeeWei,
      ethUsdPrice: pickString(data, "eth_usd_price"),
    });
    if (networkFeeUsdMicros === null) {
      return NextResponse.json(
        { error: "computed_fee_usd_micros or computed_fee (wei) is required" },
        { status: 400 },
      );
    }

    const result = await ingestSignedTicketDurable({
      clientId,
      externalUserId,
      requestId,
      networkFeeUsdMicros,
      feeWei: optionalString(computedFeeWei),
      pixels: optionalString(pickString(data, "pixels")),
      pipeline: optionalString(pickString(data, "pipeline")),
      modelId: optionalString(pickString(data, "model_id")),
      ethUsdPrice: optionalString(pickString(data, "eth_usd_price")),
      ethUsdObservedAt: optionalString(
        pickString(data, "eth_usd_updated_at", "eth_usd_observed_at"),
      ),
    });

    if (result.status === "unknown_client") {
      return NextResponse.json({ error: "Unknown client_id" }, { status: 404 });
    }

    return NextResponse.json({
      ok: true,
      diagnostic: false,
      ingested: true,
      duplicate: result.duplicate,
      requestId,
      openmeterEventId: result.openmeterEventId,
    });
  }

  const app = await getProviderApp(clientId);
  if (!app) {
    return NextResponse.json({ error: "Unknown client_id" }, { status: 404 });
  }

  await db
    .insert(usageIngestReceipts)
    .values({
      id: uuidv4(),
      clientId: app.id,
      requestId,
      openmeterEventId: `diagnostic:${requestId}`,
      externalUserId,
      createdAt: new Date().toISOString(),
    })
    .onConflictDoNothing({
      target: [usageIngestReceipts.clientId, usageIngestReceipts.requestId],
    });

  return NextResponse.json({
    ok: true,
    diagnostic: true,
    ingested: false,
    duplicate: false,
    requestId,
  });
}
