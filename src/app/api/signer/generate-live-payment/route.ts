import { NextRequest, NextResponse } from "next/server";
import { getGenerateLivePaymentHandler } from "@/lib/signer-direct-handler";

export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  try {
    const handler = getGenerateLivePaymentHandler();
    return handler(request);
  } catch (error) {
    console.error("[api] generate-live-payment error:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
