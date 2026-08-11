import { NextRequest, NextResponse } from "next/server";

import { readJsonObjectBody } from "@/lib/billing/owner-wallet-m2m-auth";
import { walletUpstreamErrorResponse } from "@/lib/billing/wallet-http";
import { resolveWalletRouteContext } from "@/lib/billing/wallet-route-context";
import {
  createAppUserPaymentMethodCheckout,
  ensureAppUserDefaultPaymentMethodIfMissing,
  listAppUserPaymentMethods,
  setAppUserDefaultPaymentMethod,
} from "@/lib/openmeter/app-user-payment-method";
import {
  createOwnerPaymentMethodCheckout,
  ensureOwnerDefaultPaymentMethodIfMissing,
  listOwnerPaymentMethods,
  setOwnerDefaultPaymentMethod,
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
  const resolved = await resolveWalletRouteContext({
    request,
    clientId,
    externalUserId: request.nextUrl.searchParams.get("externalUserId"),
  });
  if (!resolved.ok) {
    return resolved.response;
  }
  const { app, target } = resolved.context;

  try {
    if (target.mode === "merchant") {
      const paymentMethods = await listAppUserPaymentMethods({
        clientId: app.id,
        externalUserId: target.externalUserId,
      });
      return NextResponse.json({ paymentMethods });
    }
    const paymentMethods = await listOwnerPaymentMethods(
      target.ownerUserId,
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
  const body = await readJsonObjectBody(request);
  const resolved = await resolveWalletRouteContext({
    request,
    clientId,
    externalUserId: body.externalUserId,
  });
  if (!resolved.ok) {
    return resolved.response;
  }
  const { app, target } = resolved.context;

  const successUrl =
    typeof body.successUrl === "string" ? body.successUrl : undefined;
  const cancelUrl =
    typeof body.cancelUrl === "string" ? body.cancelUrl : undefined;

  try {
    if (target.mode === "merchant") {
      const checkout = await createAppUserPaymentMethodCheckout({
        clientId: app.id,
        externalUserId: target.externalUserId,
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
      ownerUserId: target.ownerUserId,
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

/**
 * PATCH /api/v1/apps/{clientId}/billing/wallet/payment-methods — set default
 * or `{ ensureDefault: true }` after Checkout return.
 */
export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id: clientId } = await params;
  const body = await readJsonObjectBody(request);
  const resolved = await resolveWalletRouteContext({
    request,
    clientId,
    externalUserId: body.externalUserId,
  });
  if (!resolved.ok) {
    return resolved.response;
  }
  const { app, target } = resolved.context;

  try {
    if (body.ensureDefault === true) {
      if (target.mode === "merchant") {
        const result = await ensureAppUserDefaultPaymentMethodIfMissing({
          clientId: app.id,
          externalUserId: target.externalUserId,
        });
        return NextResponse.json(result);
      }
      const result = await ensureOwnerDefaultPaymentMethodIfMissing(
        target.ownerUserId,
      );
      return NextResponse.json(result);
    }

    const paymentMethodId =
      typeof body.paymentMethodId === "string"
        ? body.paymentMethodId.trim()
        : "";
    if (!paymentMethodId) {
      return NextResponse.json(
        { error: "paymentMethodId is required" },
        { status: 400 },
      );
    }

    if (target.mode === "merchant") {
      const result = await setAppUserDefaultPaymentMethod({
        clientId: app.id,
        externalUserId: target.externalUserId,
        paymentMethodId,
      });
      if (!result.updated) {
        return NextResponse.json(
          { error: "Payment method not found", ...result },
          { status: 404 },
        );
      }
      return NextResponse.json(result);
    }
    const result = await setOwnerDefaultPaymentMethod(
      target.ownerUserId,
      paymentMethodId,
    );
    if (!result.updated) {
      return NextResponse.json(
        { error: "Payment method not found", ...result },
        { status: 404 },
      );
    }
    return NextResponse.json(result);
  } catch (err) {
    return walletUpstreamErrorResponse(err, "payment-method default");
  }
}
