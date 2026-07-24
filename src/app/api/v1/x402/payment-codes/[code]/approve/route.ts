import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/next-auth-options";
import { x402PaymentPayloadSchema } from "@/lib/x402";
import {
  approvePaymentCode,
  denyPaymentCode,
  getPaymentCodeByUserCode,
  isPaymentCodeExpired,
} from "@/lib/x402/payment-codes";

/**
 * POST /api/v1/x402/payment-codes/{code}/approve
 * Browser session approves (with signed payload) or denies a payment code.
 * {code} is the user_code.
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ code: string }> },
) {
  const session = await getServerSession(authOptions);
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { code } = await params;
  const userCode = decodeURIComponent(code).trim().toUpperCase();

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const record = body as {
    action?: string;
    paymentPayload?: unknown;
    externalUserId?: string;
  };

  if (record.action === "deny") {
    const denied = await denyPaymentCode(userCode);
    if (!denied) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }
    return NextResponse.json({ status: "denied" });
  }

  const row = await getPaymentCodeByUserCode(userCode);
  if (!row) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  if (isPaymentCodeExpired(row)) {
    return NextResponse.json({ error: "expired" }, { status: 410 });
  }

  const payload = x402PaymentPayloadSchema.safeParse(record.paymentPayload);
  if (!payload.success) {
    return NextResponse.json(
      { error: "Invalid paymentPayload", details: payload.error.flatten() },
      { status: 400 },
    );
  }

  const sessionUser = session.user as Record<string, unknown>;
  const externalUserId =
    record.externalUserId?.trim() ||
    (typeof sessionUser.id === "string" ? sessionUser.id : null);

  const result = await approvePaymentCode({
    userCode,
    paymentPayload: payload.data,
    externalUserId,
  });
  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: result.status });
  }

  return NextResponse.json({ status: "approved" });
}

/**
 * GET /api/v1/x402/payment-codes/{code}/approve — lookup requirements for the UI.
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ code: string }> },
) {
  const { code } = await params;
  const userCode = decodeURIComponent(code).trim().toUpperCase();
  const row = await getPaymentCodeByUserCode(userCode);
  if (!row) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  if (isPaymentCodeExpired(row)) {
    return NextResponse.json({ status: "expired" });
  }

  let paymentRequirements: unknown = null;
  try {
    paymentRequirements = JSON.parse(row.paymentRequirements);
  } catch {
    paymentRequirements = null;
  }

  return NextResponse.json({
    status: row.status,
    userCode: row.userCode,
    paymentRequirements,
    expiresAt: row.expiresAt,
  });
}
