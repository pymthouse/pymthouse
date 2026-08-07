import { NextRequest, NextResponse } from "next/server";

import {
  authorizeOwnerBillingM2m,
  readJsonObject,
} from "@/lib/billing/owner-billing-m2m-auth";
import {
  paymentMethodCheckoutErrorResponse,
  paymentMethodDefaultErrorResponse,
  paymentMethodUnlinkErrorResponse,
} from "@/lib/billing/payment-method-http";
import {
  createOwnerPaymentMethodCheckout,
  listOwnerPaymentMethods,
  setOwnerDefaultPaymentMethod,
  unlinkOwnerPaymentMethod,
} from "@/lib/openmeter/owner-payment-method";

async function paymentMethodIdFromRequest(
  request: NextRequest,
): Promise<string | null> {
  const fromQuery = request.nextUrl.searchParams.get("id")?.trim();
  if (fromQuery) {
    return fromQuery;
  }
  const body = await readJsonObject(request);
  return typeof body.paymentMethodId === "string"
    ? body.paymentMethodId.trim() || null
    : null;
}

async function authorizeOwnerPaymentMethodMutation(
  request: NextRequest,
  clientId: string,
): Promise<
  | { ownerUserId: string; paymentMethodId: string }
  | NextResponse
> {
  const auth = await authorizeOwnerBillingM2m(request, clientId);
  if (!auth) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  const paymentMethodId = await paymentMethodIdFromRequest(request);
  if (!paymentMethodId) {
    return NextResponse.json(
      { error: "paymentMethodId is required" },
      { status: 400 },
    );
  }
  return { ownerUserId: auth.ownerUserId, paymentMethodId };
}

/**
 * GET /api/v1/apps/{clientId}/billing/payment-methods
 * List payment methods on the app owner wallet. Auth: M2M Basic only.
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id: clientId } = await params;
  const auth = await authorizeOwnerBillingM2m(request, clientId);
  if (!auth) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  return NextResponse.json({
    paymentMethods: await listOwnerPaymentMethods(auth.ownerUserId),
  });
}

/**
 * POST /api/v1/apps/{clientId}/billing/payment-methods
 * Start Stripe Checkout (setup) for the app owner wallet.
 * Body: optional `{ successUrl, cancelUrl }`. Auth: M2M Basic only.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id: clientId } = await params;
  const auth = await authorizeOwnerBillingM2m(request, clientId);
  if (!auth) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const body = await readJsonObject(request);

  try {
    const result = await createOwnerPaymentMethodCheckout({
      ownerUserId: auth.ownerUserId,
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
 * PATCH /api/v1/apps/{clientId}/billing/payment-methods
 * Set default payment method (`?id=` or `{ paymentMethodId }`).
 */
export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id: clientId } = await params;
  const prepared = await authorizeOwnerPaymentMethodMutation(request, clientId);
  if (prepared instanceof NextResponse) {
    return prepared;
  }

  try {
    const result = await setOwnerDefaultPaymentMethod(
      prepared.ownerUserId,
      prepared.paymentMethodId,
    );
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

/**
 * DELETE /api/v1/apps/{clientId}/billing/payment-methods
 * Detach a payment method (`?id=` or `{ paymentMethodId }`).
 */
export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id: clientId } = await params;
  const prepared = await authorizeOwnerPaymentMethodMutation(request, clientId);
  if (prepared instanceof NextResponse) {
    return prepared;
  }

  try {
    const result = await unlinkOwnerPaymentMethod(
      prepared.ownerUserId,
      prepared.paymentMethodId,
    );
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
