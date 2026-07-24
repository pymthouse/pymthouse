import { NextResponse } from "next/server";
import {
  authenticateX402AgentOrApp,
  requireX402EnabledApp,
} from "@/lib/x402";
import {
  consumeApprovedPaymentCode,
  getActivePaymentCode,
  isPaymentCodeExpired,
} from "@/lib/x402/payment-codes";

/**
 * GET /api/v1/x402/payment-codes/{code}
 * Poll by device_code (preferred) or user_code.
 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ code: string }> },
) {
  const auth = await authenticateX402AgentOrApp(request, {
    rateLimitKeyPrefix: "x402-payment-codes-poll",
  });
  if (!auth.ok) {
    return auth.response;
  }
  const disabled = await requireX402EnabledApp(auth.context);
  if (disabled) {
    return disabled;
  }

  const { code } = await params;
  const row = await getActivePaymentCode(decodeURIComponent(code));
  if (!row || row.clientId !== auth.context.appId) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  if (isPaymentCodeExpired(row)) {
    return NextResponse.json({ status: "expired" });
  }

  if (row.status === "pending") {
    return NextResponse.json({ status: "pending" });
  }
  if (row.status === "denied") {
    return NextResponse.json({ status: "denied" });
  }
  if (row.status === "consumed") {
    return NextResponse.json({ status: "consumed" });
  }

  // On first successful poll after approval, return payload and mark consumed
  // when polling with the device_code (secret).
  if (row.deviceCode === decodeURIComponent(code)) {
    const consumed = await consumeApprovedPaymentCode(row.deviceCode);
    if (consumed.status === "approved") {
      return NextResponse.json({
        status: "approved",
        paymentPayload: consumed.paymentPayload,
        paymentRequirements: consumed.paymentRequirements,
        externalUserId: consumed.externalUserId,
      });
    }
    return NextResponse.json({ status: consumed.status });
  }

  return NextResponse.json({
    status: row.status,
    // user_code poll does not reveal the signed payload
  });
}
