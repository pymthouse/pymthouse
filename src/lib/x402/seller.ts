import { NextResponse } from "next/server";
import { getEthAddr } from "@/lib/signer-cli";
import {
  BASE_MAINNET_CAIP2,
  BASE_USDC_ADDRESS,
  type X402PaymentRequirements,
} from "@/lib/x402/types";
import { buildPaymentRequiredHeader } from "@/lib/x402/eip3009";

export type X402SellerOptions = {
  resource: string;
  maxAmountRequired: string;
  description?: string;
  mimeType?: string;
  maxTimeoutSeconds?: number;
  payTo?: string;
  facilitatorUrl?: string;
};

/**
 * Build a 402 Payment Required response for x402 exact-scheme USDC on Base.
 */
export async function buildX402PaymentRequiredResponse(
  options: X402SellerOptions,
): Promise<NextResponse> {
  const payTo = options.payTo ?? (await getEthAddr());
  if (!payTo) {
    return NextResponse.json({ error: "payTo address unavailable" }, { status: 503 });
  }

  const facilitatorUrl =
    options.facilitatorUrl?.trim() ||
    `${process.env.NEXTAUTH_URL?.replace(/\/$/, "") || "http://localhost:3001"}/api/v1/x402`;

  const requirements: X402PaymentRequirements & { facilitator: string } = {
    scheme: "exact",
    network: BASE_MAINNET_CAIP2,
    maxAmountRequired: options.maxAmountRequired,
    resource: options.resource,
    description: options.description,
    mimeType: options.mimeType,
    payTo,
    maxTimeoutSeconds: options.maxTimeoutSeconds ?? 300,
    asset: BASE_USDC_ADDRESS,
    facilitator: facilitatorUrl,
  };

  const encoded = buildPaymentRequiredHeader(requirements);
  return new NextResponse(JSON.stringify({ error: "payment_required", requirements }), {
    status: 402,
    headers: {
      "Content-Type": "application/json",
      "PAYMENT-REQUIRED": encoded,
    },
  });
}
