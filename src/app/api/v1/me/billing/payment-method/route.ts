import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";

import { authOptions } from "@/lib/next-auth-options";
import { createOwnerPaymentMethodCheckout } from "@/lib/openmeter/owner-payment-method";

/**
 * Start Stripe Checkout (setup) so the signed-in owner can attach a payment
 * method for platform cost-rail invoices (OpenMeter Stripe app / Plane A).
 */
export async function POST(request: NextRequest) {
  const session = await getServerSession(authOptions);
  const sessionUser = session?.user as Record<string, unknown> | undefined;
  const userId = typeof sessionUser?.id === "string" ? sessionUser.id : undefined;
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
    const status =
      message.includes("STRIPE_") ||
      message.includes("OPENMETER_") ||
      message.includes("No ready Stripe") ||
      message.includes("No Stripe app")
        ? 400
        : message.includes("Cannot reach OpenMeter")
          ? 503
          : 502;
    return NextResponse.json({ error: message }, { status });
  }
}
