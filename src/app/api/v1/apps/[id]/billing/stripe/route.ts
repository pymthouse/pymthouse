import { NextRequest, NextResponse } from "next/server";
import {
  canManageMerchantBilling,
  getAuthorizedProviderApp,
  merchantBillingForbiddenResponse,
} from "@/lib/provider-apps";
import {
  disconnectStripeConnect,
  getStripeConnectStatus,
} from "@/lib/openmeter/stripe-connect";
import { getAppOpenMeterConfigRow } from "@/lib/openmeter/client-factory";
import { updateAppCheckoutUrls } from "@/lib/openmeter/subscriptions-billing";

async function requireHostedBillingApp(clientId: string) {
  const auth = await getAuthorizedProviderApp(clientId);
  if (!auth) {
    return null;
  }
  const omConfig = await getAppOpenMeterConfigRow(auth.app.id);
  const mode = omConfig?.mode || "pymthouse_hosted";
  if (mode !== "pymthouse_hosted") {
    return { auth, error: NextResponse.json({ error: "Billing connect requires pymthouse_hosted OpenMeter mode" }, { status: 400 }) };
  }
  return { auth, error: null as NextResponse | null };
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id: clientId } = await params;
  const access = await requireHostedBillingApp(clientId);
  if (!access) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  if (access.error) {
    return access.error;
  }

  const status = await getStripeConnectStatus(access.auth.app.id);
  return NextResponse.json({ clientId: access.auth.app.id, ...status });
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id: clientId } = await params;
  const access = await requireHostedBillingApp(clientId);
  if (!access) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  if (access.error) {
    return access.error;
  }
  if (!(await canManageMerchantBilling(access.auth))) {
    return merchantBillingForbiddenResponse();
  }

  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const taxRaw = body.taxBehavior;
  let taxBehavior: "inclusive" | "exclusive" | null | undefined = undefined;
  if (taxRaw === null) {
    taxBehavior = null;
  } else if (taxRaw === "inclusive" || taxRaw === "exclusive") {
    taxBehavior = taxRaw;
  } else if (taxRaw !== undefined) {
    return NextResponse.json(
      { error: "taxBehavior must be inclusive, exclusive, or null" },
      { status: 400 },
    );
  }

  try {
    await updateAppCheckoutUrls({
      clientId: access.auth.app.id,
      checkoutSuccessUrl:
        body.checkoutSuccessUrl === undefined
          ? undefined
          : body.checkoutSuccessUrl === null
            ? null
            : String(body.checkoutSuccessUrl),
      checkoutCancelUrl:
        body.checkoutCancelUrl === undefined
          ? undefined
          : body.checkoutCancelUrl === null
            ? null
            : String(body.checkoutCancelUrl),
      defaultCurrency:
        typeof body.defaultCurrency === "string" ? body.defaultCurrency : undefined,
      taxBehavior,
    });
    const status = await getStripeConnectStatus(access.auth.app.id);
    return NextResponse.json({ clientId: access.auth.app.id, ...status });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: message }, { status: 400 });
  }
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id: clientId } = await params;
  const access = await requireHostedBillingApp(clientId);
  if (!access) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  if (access.error) {
    return access.error;
  }
  if (!(await canManageMerchantBilling(access.auth))) {
    return merchantBillingForbiddenResponse();
  }

  await disconnectStripeConnect(access.auth.app.id);
  return NextResponse.json({ success: true });
}
