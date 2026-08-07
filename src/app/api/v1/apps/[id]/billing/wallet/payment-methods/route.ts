import { NextRequest, NextResponse } from "next/server";

import {
  authorizeOwnerWalletM2m,
  readJsonObjectBody,
} from "@/lib/billing/owner-wallet-m2m-auth";
import { walletUpstreamErrorResponse } from "@/lib/billing/wallet-http";
import {
  createOwnerPaymentMethodCheckout,
  listOwnerPaymentMethods,
} from "@/lib/openmeter/owner-payment-method";

/**
 * GET /api/v1/apps/{clientId}/billing/wallet/payment-methods — payment
 * methods attached to the owner wallet's platform Stripe customer
 * (brand + last4 only).
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id: clientId } = await params;
  const access = await authorizeOwnerWalletM2m(request, clientId);
  if (!access) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const paymentMethods = await listOwnerPaymentMethods(access.ownerUserId);
  return NextResponse.json({ paymentMethods });
}

/**
 * POST /api/v1/apps/{clientId}/billing/wallet/payment-methods — start a
 * setup-mode Stripe Checkout session that attaches a payment method for
 * threshold auto-debit. Body: `{ "successUrl"?, "cancelUrl"? }` (must be
 * same-origin `/billing` URLs; anything else falls back to the platform
 * billing page).
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
  try {
    const checkout = await createOwnerPaymentMethodCheckout({
      ownerUserId: access.ownerUserId,
      successUrl: typeof body.successUrl === "string" ? body.successUrl : undefined,
      cancelUrl: typeof body.cancelUrl === "string" ? body.cancelUrl : undefined,
    });
    return NextResponse.json({
      checkoutUrl: checkout.checkoutUrl,
      sessionId: checkout.sessionId,
      hasDefaultPaymentMethod: checkout.hasDefaultPaymentMethod,
    });
  } catch (err) {
    return walletUpstreamErrorResponse(err, "payment-method checkout");
  }
}
