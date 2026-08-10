import { NextRequest, NextResponse } from "next/server";

import {
  authorizeAppUserBillingRoute,
  isAppUserBillingAccess,
} from "@/lib/billing/app-user-billing-route";
import { readJsonObject } from "@/lib/billing/owner-billing-m2m-auth";
import {
  createAppUserPaymentMethodCheckout,
  ensureAppUserDefaultPaymentMethodIfMissing,
  listAppUserPaymentMethods,
  setAppUserDefaultPaymentMethod,
  unlinkAppUserPaymentMethod,
} from "@/lib/openmeter/app-user-payment-method";
import {
  paymentMethodCheckoutErrorResponse,
  paymentMethodDefaultErrorResponse,
  paymentMethodUnlinkErrorResponse,
} from "@/lib/billing/payment-method-http";

/**
 * GET /api/v1/apps/{clientId}/users/{externalUserId}/payment-methods
 *
 * List cards on the app end-user's Stripe customer (not owner wallet).
 * Auth: `authorizeAppForBilling`.
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; externalUserId: string }> },
) {
  const { id: clientId, externalUserId: raw } = await params;
  const access = await authorizeAppUserBillingRoute(request, clientId, raw);
  if (!isAppUserBillingAccess(access)) {
    return access;
  }

  // Fail open on provider outages — list UI should show "none on file", not
  // a hard 500. Wallet M2M (`…/billing/wallet/payment-methods`) maps the same
  // throws to 502/503 via walletUpstreamErrorResponse.
  let paymentMethods: Awaited<ReturnType<typeof listAppUserPaymentMethods>> =
    [];
  try {
    paymentMethods = await listAppUserPaymentMethods({
      clientId: access.app.id,
      externalUserId: access.externalUserId,
    });
  } catch {
    paymentMethods = [];
  }
  return NextResponse.json({ paymentMethods });
}

/**
 * POST /api/v1/apps/{clientId}/users/{externalUserId}/payment-methods
 *
 * Setup-only Stripe Checkout for the app end-user. Does not change plan.
 * Body: optional `{ successUrl, cancelUrl }`. Auth: `authorizeAppForBilling`.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; externalUserId: string }> },
) {
  const { id: clientId, externalUserId: raw } = await params;
  const access = await authorizeAppUserBillingRoute(request, clientId, raw);
  if (!isAppUserBillingAccess(access)) {
    return access;
  }

  const body = await readJsonObject(request);

  try {
    const result = await createAppUserPaymentMethodCheckout({
      clientId: access.app.id,
      externalUserId: access.externalUserId,
      successUrl:
        typeof body.successUrl === "string" ? body.successUrl : undefined,
      cancelUrl:
        typeof body.cancelUrl === "string" ? body.cancelUrl : undefined,
    });
    return NextResponse.json(result);
  } catch (err) {
    return paymentMethodCheckoutErrorResponse(err);
  }
}

/**
 * PATCH sets the default payment method for this app user's billing customer.
 * Body `{ ensureDefault: true }` promotes the first attached PM when none is
 * default yet (post-Checkout return).
 */
export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; externalUserId: string }> },
) {
  const { id: clientId, externalUserId: raw } = await params;
  const access = await authorizeAppUserBillingRoute(request, clientId, raw);
  if (!isAppUserBillingAccess(access)) {
    return access;
  }

  const body = await readJsonObject(request);
  if (body.ensureDefault === true) {
    try {
      const result = await ensureAppUserDefaultPaymentMethodIfMissing({
        clientId: access.app.id,
        externalUserId: access.externalUserId,
      });
      return NextResponse.json(result);
    } catch (err) {
      return paymentMethodDefaultErrorResponse(err);
    }
  }

  const paymentMethodId =
    request.nextUrl.searchParams.get("id")?.trim() ||
    (typeof body.paymentMethodId === "string"
      ? body.paymentMethodId.trim()
      : "");
  if (!paymentMethodId) {
    return NextResponse.json(
      { error: "paymentMethodId is required" },
      { status: 400 },
    );
  }

  try {
    const result = await setAppUserDefaultPaymentMethod({
      clientId: access.app.id,
      externalUserId: access.externalUserId,
      paymentMethodId,
    });
    if (!result.updated) {
      return NextResponse.json(
        { error: "Payment method not found", ...result },
        { status: 404 },
      );
    }
    return NextResponse.json(result);
  } catch (err) {
    return paymentMethodDefaultErrorResponse(err);
  }
}

/** DELETE detaches a payment method from this app user's billing customer. */
export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; externalUserId: string }> },
) {
  const { id: clientId, externalUserId: raw } = await params;
  const access = await authorizeAppUserBillingRoute(request, clientId, raw);
  if (!isAppUserBillingAccess(access)) {
    return access;
  }
  const body = await readJsonObject(request);
  const paymentMethodId =
    request.nextUrl.searchParams.get("id")?.trim() ||
    (typeof body.paymentMethodId === "string"
      ? body.paymentMethodId.trim()
      : "");
  if (!paymentMethodId) {
    return NextResponse.json(
      { error: "paymentMethodId is required" },
      { status: 400 },
    );
  }
  try {
    const result = await unlinkAppUserPaymentMethod({
      clientId: access.app.id,
      externalUserId: access.externalUserId,
      paymentMethodId,
    });
    if (!result.unlinked) {
      return NextResponse.json(
        { error: "Payment method not found", ...result },
        { status: 404 },
      );
    }
    return NextResponse.json(result);
  } catch (err) {
    return paymentMethodUnlinkErrorResponse(err);
  }
}
