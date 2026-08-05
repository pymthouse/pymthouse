import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";

import { authOptions } from "@/lib/next-auth-options";
import {
  createOwnerPaymentMethodCheckout,
  listOwnerPaymentMethods,
  setOwnerDefaultPaymentMethod,
  unlinkOwnerPaymentMethod,
} from "@/lib/openmeter/owner-payment-method";

function sessionUserId(session: unknown): string | undefined {
  if (!session || typeof session !== "object") {
    return undefined;
  }
  const user = (session as { user?: unknown }).user;
  if (!user || typeof user !== "object") {
    return undefined;
  }
  const id = (user as { id?: unknown }).id;
  return typeof id === "string" ? id : undefined;
}

async function paymentMethodIdFromRequest(
  request: NextRequest,
): Promise<string | null> {
  const fromQuery = request.nextUrl.searchParams.get("id")?.trim();
  if (fromQuery) {
    return fromQuery;
  }
  try {
    const body = (await request.json()) as { paymentMethodId?: unknown };
    return typeof body.paymentMethodId === "string"
      ? body.paymentMethodId.trim() || null
      : null;
  } catch {
    return null;
  }
}

/** Every payment method attached to the signed-in owner, default flagged. */
export async function GET() {
  const session = await getServerSession(authOptions);
  const userId = sessionUserId(session);
  if (!userId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  return NextResponse.json({
    paymentMethods: await listOwnerPaymentMethods(userId),
  });
}

/**
 * Start Stripe Checkout (setup) so the signed-in owner can attach a payment
 * method for platform cost-rail invoices (OpenMeter Stripe app / Plane A).
 */
export async function POST(request: NextRequest) {
  const session = await getServerSession(authOptions);
  const userId = sessionUserId(session);
  if (!userId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: Record<string, unknown> = {};
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    body = {};
  }

  try {
    const result = await createOwnerPaymentMethodCheckout({
      ownerUserId: userId,
      successUrl:
        typeof body.successUrl === "string" ? body.successUrl : undefined,
      cancelUrl: typeof body.cancelUrl === "string" ? body.cancelUrl : undefined,
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

/** Make one attached payment method the default for plan fee & overage. */
export async function PATCH(request: NextRequest) {
  const session = await getServerSession(authOptions);
  const userId = sessionUserId(session);
  if (!userId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const paymentMethodId = await paymentMethodIdFromRequest(request);
  if (!paymentMethodId) {
    return NextResponse.json(
      { error: "paymentMethodId is required" },
      { status: 400 },
    );
  }

  try {
    const result = await setOwnerDefaultPaymentMethod(userId, paymentMethodId);
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

/** Detach one of the owner's Stripe payment methods (Plane A). */
export async function DELETE(request: NextRequest) {
  const session = await getServerSession(authOptions);
  const userId = sessionUserId(session);
  if (!userId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const paymentMethodId = await paymentMethodIdFromRequest(request);
  if (!paymentMethodId) {
    return NextResponse.json(
      { error: "paymentMethodId is required" },
      { status: 400 },
    );
  }

  try {
    // Last-method + empty-list checks run inside unlink under an owner-scoped
    // lock so concurrent DELETEs recheck immediately before detach.
    const result = await unlinkOwnerPaymentMethod(userId, paymentMethodId);
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
