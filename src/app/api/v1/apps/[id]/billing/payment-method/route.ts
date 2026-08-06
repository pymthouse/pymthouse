import { NextRequest, NextResponse } from "next/server";

import {
  authorizeOwnerBillingM2m,
  readJsonObject,
} from "@/lib/billing/owner-billing-m2m-auth";
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

/**
 * GET /api/v1/apps/{clientId}/billing/payment-method
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
 * POST /api/v1/apps/{clientId}/billing/payment-method
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
    const message = err instanceof Error ? err.message : String(err);
    let status = 502;
    if (
      message.includes("STRIPE_") ||
      message.includes("OPENMETER_") ||
      message.includes("No ready Stripe") ||
      message.includes("No Stripe app")
    ) {
      status = 400;
    } else if (message.includes("Cannot reach OpenMeter")) {
      status = 503;
    }
    return NextResponse.json({ error: message }, { status });
  }
}

/**
 * PATCH /api/v1/apps/{clientId}/billing/payment-method
 * Set default payment method (`?id=` or `{ paymentMethodId }`).
 */
export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id: clientId } = await params;
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

  try {
    const result = await setOwnerDefaultPaymentMethod(
      auth.ownerUserId,
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
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: message }, { status: 502 });
  }
}

/**
 * DELETE /api/v1/apps/{clientId}/billing/payment-method
 * Detach a payment method (`?id=` or `{ paymentMethodId }`).
 */
export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id: clientId } = await params;
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

  try {
    const result = await unlinkOwnerPaymentMethod(
      auth.ownerUserId,
      paymentMethodId,
    );
    if (!result.unlinked) {
      return NextResponse.json(
        { error: "Payment method not found", ...result },
        { status: 404 },
      );
    }
    return NextResponse.json(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes("Unable to verify payment methods")) {
      return NextResponse.json({ error: message }, { status: 503 });
    }
    if (message.includes("only payment method")) {
      return NextResponse.json({ error: message }, { status: 409 });
    }
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
