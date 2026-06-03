import { NextRequest, NextResponse } from "next/server";
import {
  canManageMerchantBilling,
  getAuthorizedProviderApp,
  merchantBillingForbiddenResponse,
} from "@/lib/provider-apps";
import {
  connectStripeWithApiKey,
  createStripeOAuthState,
  StripeOAuthUnavailableError,
} from "@/lib/openmeter/stripe-connect";
import { getAppOpenMeterConfigRow } from "@/lib/openmeter/client-factory";

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id: clientId } = await params;
  const auth = await getAuthorizedProviderApp(clientId, request);
  if (!auth) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  if (!(await canManageMerchantBilling(auth))) {
    return merchantBillingForbiddenResponse();
  }

  const omConfig = await getAppOpenMeterConfigRow(auth.app.id);
  if ((omConfig?.mode || "pymthouse_hosted") !== "pymthouse_hosted") {
    return NextResponse.json(
      { error: "Billing connect requires pymthouse_hosted OpenMeter mode" },
      { status: 400 },
    );
  }

  let body: { stripeSecretKey?: string } = {};
  try {
    body = (await request.json()) as { stripeSecretKey?: string };
  } catch {
    /* empty body → OAuth */
  }

  const stripeSecretKey = body.stripeSecretKey?.trim();
  if (stripeSecretKey) {
    try {
      await connectStripeWithApiKey({
        clientId: auth.app.id,
        stripeSecretKey,
      });
      return NextResponse.json({ method: "api_key", connected: true });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const status = message.includes("Cannot reach OpenMeter") ? 503 : 502;
      return NextResponse.json({ error: message }, { status });
    }
  }

  try {
    const { url } = await createStripeOAuthState({
      clientId: auth.app.id,
      userId: auth.userId,
    });
    return NextResponse.json({ method: "oauth", url });
  } catch (err) {
    if (err instanceof StripeOAuthUnavailableError) {
      return NextResponse.json({
        method: "api_key",
        message:
          "Self-hosted OpenMeter does not support Stripe OAuth. Connect using a restricted secret key from the Stripe Dashboard for this merchant account.",
      });
    }
    const message = err instanceof Error ? err.message : String(err);
    const status = message.includes("Cannot reach OpenMeter") ? 503 : 502;
    return NextResponse.json({ error: message }, { status });
  }
}
