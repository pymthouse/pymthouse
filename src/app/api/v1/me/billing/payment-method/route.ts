import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";

import { authOptions } from "@/lib/next-auth-options";
import {
  createOwnerPaymentMethodCheckout,
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

/** Detach the owner's default Stripe payment method (Plane A). */
export async function DELETE() {
  const session = await getServerSession(authOptions);
  const userId = sessionUserId(session);
  if (!userId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const result = await unlinkOwnerPaymentMethod(userId);
    if (!result.unlinked) {
      return NextResponse.json(
        { error: "No payment method on file", ...result },
        { status: 404 },
      );
    }
    return NextResponse.json(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
