import { NextRequest, NextResponse } from "next/server";

import {
  authorizeOwnerWalletM2m,
  readJsonObjectBody,
} from "@/lib/billing/owner-wallet-m2m-auth";
import { walletUpstreamErrorResponse } from "@/lib/billing/wallet-http";
import {
  createOwnerTopUpCheckoutSession,
  parseTopUpAmountUsd,
} from "@/lib/stripe/topup-checkout";

/**
 * POST /api/v1/apps/{clientId}/billing/wallet/top-up
 *
 * Body: `{ "amountUsd": "25.00", "successUrl"?, "cancelUrl"? }`.
 * Returns a payment-mode Stripe Checkout URL. Once the session is paid,
 * the platform webhook grants the amount to the owner's prepaid wallet
 * (idempotent on the Checkout session id — retries never double-credit).
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id: clientId } = await params;
  const access = await authorizeOwnerWalletM2m(request, clientId);
  if (!access) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const body = await readJsonObjectBody(request);
  const amount = parseTopUpAmountUsd(body.amountUsd);
  if (!amount.ok) {
    return NextResponse.json({ error: amount.error }, { status: 400 });
  }

  try {
    const idempotencyKey = request.headers.get("Idempotency-Key")?.trim() || undefined;
    const checkout = await createOwnerTopUpCheckoutSession({
      ownerUserId: access.ownerUserId,
      publicClientId: clientId,
      amountUsdMicros: amount.amountUsdMicros,
      successUrl: typeof body.successUrl === "string" ? body.successUrl : undefined,
      cancelUrl: typeof body.cancelUrl === "string" ? body.cancelUrl : undefined,
      idempotencyKey,
    });
    return NextResponse.json({
      checkoutUrl: checkout.checkoutUrl,
      sessionId: checkout.sessionId,
      amountUsdMicros: checkout.amountUsdMicros,
    });
  } catch (err) {
    return walletUpstreamErrorResponse(err, "top-up checkout");
  }
}
