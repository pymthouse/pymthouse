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
} from "@/lib/openmeter/app-user-payment-method";

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
