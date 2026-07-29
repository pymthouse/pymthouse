import { NextRequest, NextResponse } from "next/server";
import {
  canManageMerchantBilling,
  getAuthorizedProviderApp,
  merchantBillingForbiddenResponse,
} from "@/lib/provider-apps";
import {
  updateAppBillingProfileSettings,
} from "@/lib/openmeter/billing-profiles";
import {
  parseInvoiceThresholdUsdMicrosInput,
  parseProgressiveBillingInput,
} from "@/lib/openmeter/billing-profile-settings";
import {
  disconnectStripeConnect,
  getStripeConnectStatus,
} from "@/lib/openmeter/stripe-app-install";
import { getAppOpenMeterConfigRow } from "@/lib/openmeter/client-factory";

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
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  if (
    body.progressiveBilling === undefined &&
    body.invoiceThresholdUsdMicros === undefined &&
    body.applicationFeeBps === undefined
  ) {
    return NextResponse.json(
      {
        error:
          "Provide progressiveBilling, invoiceThresholdUsdMicros, and/or applicationFeeBps to update",
      },
      { status: 400 },
    );
  }

  let progressiveBilling: boolean | undefined;
  if (body.progressiveBilling !== undefined) {
    const parsed = parseProgressiveBillingInput(body.progressiveBilling);
    if (!parsed.ok) {
      return NextResponse.json({ error: parsed.error }, { status: 400 });
    }
    progressiveBilling = parsed.value;
  }

  let invoiceThresholdUsdMicros: string | null | undefined;
  if (body.invoiceThresholdUsdMicros !== undefined) {
    const parsed = parseInvoiceThresholdUsdMicrosInput(body.invoiceThresholdUsdMicros);
    if (!parsed.ok) {
      return NextResponse.json({ error: parsed.error }, { status: 400 });
    }
    invoiceThresholdUsdMicros = parsed.value;
  }

  let applicationFeeBps: number | undefined;
  if (body.applicationFeeBps !== undefined) {
    const n =
      typeof body.applicationFeeBps === "number"
        ? body.applicationFeeBps
        : Number.parseInt(String(body.applicationFeeBps), 10);
    if (!Number.isInteger(n) || n < 0 || n > 10_000) {
      return NextResponse.json(
        { error: "applicationFeeBps must be an integer from 0 to 10000" },
        { status: 400 },
      );
    }
    applicationFeeBps = n;
  }

  try {
    const updated = await updateAppBillingProfileSettings({
      clientId: access.auth.app.id,
      progressiveBilling,
      invoiceThresholdUsdMicros,
      applicationFeeBps,
    });
    const status = await getStripeConnectStatus(access.auth.app.id);
    return NextResponse.json({
      clientId: access.auth.app.id,
      ...status,
      ...updated,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const httpStatus = message.includes("not configured")
      ? 400
      : message.includes("Cannot reach OpenMeter")
        ? 503
        : 502;
    return NextResponse.json({ error: message }, { status: httpStatus });
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
