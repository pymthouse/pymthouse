import { NextRequest, NextResponse } from "next/server";
import { authorizeAppForBilling } from "@/lib/billing/app-auth";
import { ingestSignedTicketUsage } from "@/lib/billing/signed-ticket-ingest";
import type { SignedTicketIngestInput } from "@/lib/billing/types";
import { resolveOrCreateAppUser } from "@/lib/usage/record-signed-ticket";

function optionalStringField(value: unknown): string | undefined {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed || undefined;
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return String(value);
  }
  return undefined;
}

function requiredStringField(body: Record<string, unknown>, key: string): string {
  return optionalStringField(body[key]) ?? "";
}

function parseTicketBody(body: Record<string, unknown>): SignedTicketIngestInput | null {
  const requestId = requiredStringField(body, "requestId");
  const externalUserId = requiredStringField(body, "externalUserId");
  const networkFeeUsdMicros = requiredStringField(body, "networkFeeUsdMicros");
  if (!requestId || !externalUserId || !networkFeeUsdMicros) {
    return null;
  }
  return {
    requestId,
    externalUserId,
    networkFeeUsdMicros,
    feeWei: optionalStringField(body.feeWei),
    pixels: optionalStringField(body.pixels),
    pipeline: optionalStringField(body.pipeline),
    modelId: optionalStringField(body.modelId),
    gatewayRequestId: optionalStringField(body.gatewayRequestId),
    ethUsdPrice: optionalStringField(body.ethUsdPrice),
    ethUsdRoundId: optionalStringField(body.ethUsdRoundId),
    ethUsdObservedAt: optionalStringField(body.ethUsdObservedAt),
  };
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id: clientId } = await params;
  const access = await authorizeAppForBilling(request, clientId);
  if (!access) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "invalid JSON" }, { status: 400 });
  }

  if (Array.isArray(body.tickets)) {
    const results: Array<Record<string, unknown>> = [];
    for (const raw of body.tickets) {
      const ticket = parseTicketBody((raw ?? {}) as Record<string, unknown>);
      if (!ticket) {
        results.push({ ok: false, error: "invalid ticket" });
        continue;
      }
      await resolveOrCreateAppUser({
        clientId: access.app.id,
        externalUserId: ticket.externalUserId,
      });
      const result = await ingestSignedTicketUsage({
        clientId: access.app.id,
        ticket,
      });
      results.push({ ok: true, requestId: ticket.requestId, ...result });
    }
    return NextResponse.json({ clientId, results });
  }

  const ticket = parseTicketBody(body);
  if (!ticket) {
    return NextResponse.json(
      { error: "requestId, externalUserId, and networkFeeUsdMicros are required" },
      { status: 400 },
    );
  }

  await resolveOrCreateAppUser({
    clientId: access.app.id,
    externalUserId: ticket.externalUserId,
  });

  const result = await ingestSignedTicketUsage({
    clientId: access.app.id,
    ticket,
  });

  return NextResponse.json({
    clientId,
    requestId: ticket.requestId,
    ...result,
  });
}
