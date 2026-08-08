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
  createAppUserPaymentMethodCheckout,
  listAppUserPaymentMethods,
} from "@/lib/openmeter/app-user-payment-method";
import {
  createOwnerPaymentMethodCheckout,
  listOwnerPaymentMethods,
} from "@/lib/openmeter/owner-payment-method";

/**
 * GET /api/v1/apps/{clientId}/billing/wallet/payment-methods — payment
 * methods for the resolved wallet target (owner platform customer, or
 * merchant Connect end-user customer when `billingMode=merchant`).
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

  const billingTarget = await resolveWalletBillingTarget({
    appId: access.app.id,
    ownerUserId: access.ownerUserId,
    externalUserId: readOptionalExternalUserId(
      request.nextUrl.searchParams.get("externalUserId"),
    ),
  });
  if (!billingTarget.ok) {
    return NextResponse.json(
      { error: billingTarget.error },
      { status: billingTarget.status },
    );
  }

  try {
    if (billingTarget.target.mode === "merchant") {
      const paymentMethods = await listAppUserPaymentMethods({
        clientId: access.app.id,
        externalUserId: billingTarget.target.externalUserId,
      });
      return NextResponse.json({ paymentMethods });
    }
    const paymentMethods = await listOwnerPaymentMethods(
      billingTarget.target.ownerUserId,
    );
    return NextResponse.json({ paymentMethods });
  } catch (err) {
    return walletUpstreamErrorResponse(err, "payment-method list");
  }
}

/**
 * POST /api/v1/apps/{clientId}/billing/wallet/payment-methods — start a
 * setup-mode Stripe Checkout session. Body: `{ "externalUserId"?, "successUrl"?,
 * "cancelUrl"? }`.
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

  const successUrl =
    typeof body.successUrl === "string" ? body.successUrl : undefined;
  const cancelUrl =
    typeof body.cancelUrl === "string" ? body.cancelUrl : undefined;

  try {
    if (billingTarget.target.mode === "merchant") {
      const checkout = await createAppUserPaymentMethodCheckout({
        clientId: access.app.id,
        externalUserId: billingTarget.target.externalUserId,
        successUrl,
        cancelUrl,
      });
      return NextResponse.json({
        checkoutUrl: checkout.checkoutUrl,
        sessionId: checkout.sessionId,
        hasDefaultPaymentMethod: checkout.hasDefaultPaymentMethod,
      });
    }
    const checkout = await createOwnerPaymentMethodCheckout({
      ownerUserId: billingTarget.target.ownerUserId,
      successUrl,
      cancelUrl,
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
