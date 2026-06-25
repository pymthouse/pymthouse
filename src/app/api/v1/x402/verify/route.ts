import { NextRequest, NextResponse } from "next/server";
import {
  parseX402PaymentHeader,
  verifyEip3009Payment,
} from "@/lib/x402/eip3009";
import { BASE_MAINNET_CAIP2, BASE_USDC_ADDRESS, type X402PaymentRequirements } from "@/lib/x402/types";

export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  let body: {
    paymentHeader?: string;
    requirements?: {
      scheme: "exact";
      network: string;
      maxAmountRequired: string;
      resource: string;
      payTo: string;
      maxTimeoutSeconds: number;
      asset: string;
    };
  };

  try {
    body = (await request.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const paymentHeader =
    body.paymentHeader ||
    request.headers.get("x-payment") ||
    request.headers.get("X-PAYMENT");

  const payment = parseX402PaymentHeader(paymentHeader);
  if (!payment || !body.requirements) {
    return NextResponse.json({ error: "Missing payment or requirements" }, { status: 400 });
  }

  const requirements: X402PaymentRequirements = {
    ...body.requirements,
    scheme: "exact",
    network: BASE_MAINNET_CAIP2,
    asset: BASE_USDC_ADDRESS,
  };

  try {
    const verified = await verifyEip3009Payment({ payment, requirements });
    return NextResponse.json({
      ok: true,
      payer: verified.payer,
      payTo: verified.payTo,
      value: verified.value.toString(),
      nonce: verified.nonce,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "verification_failed";
    return NextResponse.json({ ok: false, error: message }, { status: 400 });
  }
}
