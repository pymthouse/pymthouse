import { NextRequest, NextResponse } from "next/server";

import {
  authorizeOwnerWalletM2m,
  readJsonObjectBody,
} from "@/lib/billing/owner-wallet-m2m-auth";
import {
  readOptionalExternalUserId,
  resolveWalletBillingTarget,
} from "@/lib/billing/wallet-billing-target";
import { walletUpstreamErrorResponse } from "@/lib/billing/wallet-http";
import {
  createMerchantEndUserTopUpCheckoutSession,
  createOwnerTopUpCheckoutSession,
  parseTopUpAmountUsd,
} from "@/lib/stripe/topup-checkout";

/**
 * POST /api/v1/apps/{clientId}/billing/wallet/top-up
 *
 * Body: `{ "amountUsd": "25.00", "externalUserId"?, "successUrl"?, "cancelUrl"? }`.
 * Returns a payment-mode Stripe Checkout URL. Once paid, the webhook grants
 * credits (owner wallet or merchant end-user, per `billing_mode`).
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

  const billingTarget = await resolveWalletBillingTarget({
    appId: access.app.id,
    ownerUserId: access.ownerUserId,
    externalUserId: readOptionalExternalUserId(body.externalUserId),
  });
  if (!billingTarget.ok) {
    return NextResponse.json(
      { error: billingTarget.error },
      { status: billingTarget.status },
    );
  }

  try {
    const successUrl =
      typeof body.successUrl === "string" ? body.successUrl : undefined;
    const cancelUrl =
      typeof body.cancelUrl === "string" ? body.cancelUrl : undefined;

    if (billingTarget.target.mode === "merchant") {
      const checkout = await createMerchantEndUserTopUpCheckoutSession({
        publicClientId: clientId,
        appId: access.app.id,
        externalUserId: billingTarget.target.externalUserId,
        amountUsdMicros: amount.amountUsdMicros,
        successUrl,
        cancelUrl,
      });
      return NextResponse.json({
        checkoutUrl: checkout.checkoutUrl,
        sessionId: checkout.sessionId,
        amountUsdMicros: checkout.amountUsdMicros,
      });
    }

    const idempotencyKey =
      request.headers.get("Idempotency-Key")?.trim() || undefined;
    const checkout = await createOwnerTopUpCheckoutSession({
      ownerUserId: billingTarget.target.ownerUserId,
      publicClientId: clientId,
      amountUsdMicros: amount.amountUsdMicros,
      successUrl,
      cancelUrl,
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
