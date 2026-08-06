import { NextResponse } from "next/server";

/** Map checkout setup failures to HTTP status (shared by owner session + M2M). */
export function paymentMethodCheckoutErrorStatus(message: string): number {
  if (
    message.includes("STRIPE_") ||
    message.includes("OPENMETER_") ||
    message.includes("No ready Stripe") ||
    message.includes("No Stripe app")
  ) {
    return 400;
  }
  if (message.includes("Cannot reach OpenMeter")) {
    return 503;
  }
  return 502;
}

export function paymentMethodCheckoutErrorResponse(err: unknown): NextResponse {
  const message = err instanceof Error ? err.message : String(err);
  return NextResponse.json(
    { error: message },
    { status: paymentMethodCheckoutErrorStatus(message) },
  );
}

export function paymentMethodDefaultErrorResponse(err: unknown): NextResponse {
  const message = err instanceof Error ? err.message : String(err);
  return NextResponse.json({ error: message }, { status: 502 });
}

export function paymentMethodUnlinkErrorResponse(err: unknown): NextResponse {
  const message = err instanceof Error ? err.message : String(err);
  if (message.includes("Unable to verify payment methods")) {
    return NextResponse.json({ error: message }, { status: 503 });
  }
  if (message.includes("only payment method")) {
    return NextResponse.json({ error: message }, { status: 409 });
  }
  return NextResponse.json({ error: message }, { status: 502 });
}
