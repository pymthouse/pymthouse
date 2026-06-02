import { NextRequest, NextResponse } from "next/server";
import { authorizeAppForBilling } from "@/lib/billing/app-auth";
import { ingestSignedTicketUsage } from "@/lib/billing/signed-ticket-ingest";
import type { SignedTicketIngestInput } from "@/lib/billing/types";
import { resolveOrCreateAppUser } from "@/lib/usage/record-signed-ticket";

function parseTicketBody(body: Record<string, unknown>): SignedTicketIngestInput | null {
  const requestId = String(body.requestId || "").trim();
  const externalUserId = String(body.externalUserId || "").trim();
  const networkFeeUsdMicros = String(body.networkFeeUsdMicros || "").trim();
  if (!requestId || !externalUserId || !networkFeeUsdMicros) {
    return null;
  }
  return {
    requestId,
    externalUserId,
    networkFeeUsdMicros,
    feeWei: body.feeWei != null ? String(body.feeWei) : undefined,
    pixels: body.pixels != null ? String(body.pixels) : undefined,
    pipeline: body.pipeline != null ? String(body.pipeline) : undefined,
    modelId: body.modelId != null ? String(body.modelId) : undefined,
    gatewayRequestId:
      body.gatewayRequestId != null ? String(body.gatewayRequestId) : undefined,
    ethUsdPrice: body.ethUsdPrice != null ? String(body.ethUsdPrice) : undefined,
    ethUsdRoundId: body.ethUsdRoundId != null ? String(body.ethUsdRoundId) : undefined,
    ethUsdObservedAt:
      body.ethUsdObservedAt != null ? String(body.ethUsdObservedAt) : undefined,
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
