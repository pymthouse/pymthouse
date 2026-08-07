import { NextRequest, NextResponse } from "next/server";

import {
  authorizeAppUserBillingRoute,
  isAppUserBillingAccess,
} from "@/lib/billing/app-user-billing-route";
import { readJsonObject } from "@/lib/billing/owner-billing-m2m-auth";
import { paymentMethodCheckoutErrorResponse } from "@/lib/billing/payment-method-http";
import {
  createAppUserPaymentMethodCheckout,
  listAppUserPaymentMethods,
  setAppUserDefaultPaymentMethod,
  unlinkAppUserPaymentMethod,
} from "@/lib/openmeter/app-user-payment-method";
import {
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

  return NextResponse.json({
    paymentMethods: await listAppUserPaymentMethods({
      clientId: access.app.id,
      externalUserId: access.externalUserId,
    }),
  });
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

async function authorizePaymentMethodMutation(
  request: NextRequest,
  clientId: string,
  rawExternalUserId: string,
): Promise<
  | { appId: string; externalUserId: string; paymentMethodId: string }
  | NextResponse
> {
  const access = await authorizeAppUserBillingRoute(
    request,
    clientId,
    rawExternalUserId,
  );
  if (!isAppUserBillingAccess(access)) {
    return access;
  }
  const paymentMethodId =
    request.nextUrl.searchParams.get("id")?.trim() ||
    (await readJsonObject(request)).paymentMethodId;
  if (typeof paymentMethodId !== "string" || !paymentMethodId.trim()) {
    return NextResponse.json(
      { error: "paymentMethodId is required" },
      { status: 400 },
    );
  }
  return {
    appId: access.app.id,
    externalUserId: access.externalUserId,
    paymentMethodId: paymentMethodId.trim(),
  };
}

/** PATCH sets the default payment method for this app user's billing customer. */
export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; externalUserId: string }> },
) {
  const { id: clientId, externalUserId: raw } = await params;
  const prepared = await authorizePaymentMethodMutation(request, clientId, raw);
  if (prepared instanceof NextResponse) {
    return prepared;
  }
  try {
    const result = await setAppUserDefaultPaymentMethod({
      clientId: prepared.appId,
      externalUserId: prepared.externalUserId,
      paymentMethodId: prepared.paymentMethodId,
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
  const prepared = await authorizePaymentMethodMutation(request, clientId, raw);
  if (prepared instanceof NextResponse) {
    return prepared;
  }
  try {
    const result = await unlinkAppUserPaymentMethod({
      clientId: prepared.appId,
      externalUserId: prepared.externalUserId,
      paymentMethodId: prepared.paymentMethodId,
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
