import { NextRequest, NextResponse } from "next/server";
import { createHash, timingSafeEqual } from "node:crypto";
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

/**
 * Constant-time secret comparison. Both inputs are SHA-256 hashed to a fixed
 * 32-byte digest before `timingSafeEqual`, so the comparison leaks neither the
 * secret's value nor its length via timing (and never throws on length
 * mismatch). Avoids the timing side-channel of a plain `===` on the raw secret.
 */
function secretsMatch(provided: string, expected: string): boolean {
  const a = createHash("sha256").update(provided, "utf8").digest();
  const b = createHash("sha256").update(expected, "utf8").digest();
  return timingSafeEqual(a, b);
}

function verifyIngestSecret(request: NextRequest): boolean {
  const expected = process.env.INGEST_SHARED_SECRET?.trim();
  if (!expected) {
    return process.env.NODE_ENV !== "production";
  }
  const auth = request.headers.get("authorization") || "";
  if (!auth.startsWith("Bearer ")) {
    return false;
  }
  return secretsMatch(auth.slice(7).trim(), expected);
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

    let result;
    try {
      result = await ingestSignedTicketDurable({
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
    } catch {
      // Transient durable-write failure (e.g. OpenMeter unavailable). The
      // receipt is written only AFTER a successful OpenMeter write, so nothing
      // was persisted and the caller (the Benthos collector) can safely retry.
      // Surface a 502 so the failure is never silently swallowed and is clearly
      // distinct from an accepted/duplicate (2xx). Internal error details are
      // intentionally not leaked to the caller.
      return NextResponse.json(
        { ok: false, ingested: false, error: "Ingest temporarily unavailable" },
        { status: 502 },
      );
    }

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
