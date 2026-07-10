import { NextRequest, NextResponse } from "next/server";
import {
  canManageMerchantBilling,
  getAuthorizedProviderApp,
  merchantBillingForbiddenResponse,
} from "@/lib/provider-apps";
import { getHostedOpenMeterUrl } from "@/lib/openmeter/constants";
import {
  connectStripeOnKonnect,
  connectStripeWithApiKey,
  createStripeOAuthState,
  StripeOAuthUnavailableError,
} from "@/lib/openmeter/stripe-connect";
import { shouldUseKonnectRoutes } from "@/lib/openmeter/route-mode";
import { getAppOpenMeterConfigRow } from "@/lib/openmeter/client-factory";

function openMeterStatus(message: string): number {
  return message.includes("Cannot reach OpenMeter") ? 503 : 502;
}

async function readStripeSecretKey(request: NextRequest): Promise<string | undefined> {
  try {
    const body = (await request.json()) as { stripeSecretKey?: string };
    return body.stripeSecretKey?.trim() || undefined;
  } catch {
    return undefined;
  }
}

async function connectWithSecretKey(clientId: string, stripeSecretKey: string) {
  try {
    await connectStripeWithApiKey({
      clientId,
      stripeSecretKey,
    });
    return NextResponse.json({ method: "api_key", connected: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: message }, { status: openMeterStatus(message) });
  }
}

async function connectViaHostedFlow(input: {
  clientId: string;
  userId: string;
}) {
  try {
    if (
      shouldUseKonnectRoutes(getHostedOpenMeterUrl(), process.env.OPENMETER_API_KEY)
    ) {
      await connectStripeOnKonnect({ clientId: input.clientId });
      return NextResponse.json({ method: "konnect", connected: true });
    }

    const { url } = await createStripeOAuthState({
      clientId: input.clientId,
      userId: input.userId,
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
    return NextResponse.json({ error: message }, { status: openMeterStatus(message) });
  }
}

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

  const stripeSecretKey = await readStripeSecretKey(request);
  if (stripeSecretKey) {
    return connectWithSecretKey(auth.app.id, stripeSecretKey);
  }

  return connectViaHostedFlow({
    clientId: auth.app.id,
    userId: auth.userId,
  });
}
