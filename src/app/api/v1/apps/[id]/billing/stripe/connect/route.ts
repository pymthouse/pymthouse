import { NextRequest, NextResponse } from "next/server";
import {
  canManageMerchantBilling,
  getAuthorizedProviderApp,
  merchantBillingForbiddenResponse,
} from "@/lib/provider-apps";
import { getAppOpenMeterConfigRow } from "@/lib/openmeter/client-factory";
import { sanitizeForLog } from "@/lib/sanitize-for-log";
import {
  startMerchantConnect,
  type MerchantConnectMode,
} from "@/lib/stripe/merchant-connect";
import { merchantConnectOAuthErrorCode } from "@/lib/stripe/webhook";

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

  let body: Record<string, unknown> = {};
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    body = {};
  }

  const modeRaw = typeof body.mode === "string" ? body.mode.trim() : "account_link";
  if (modeRaw === "oauth") {
    return NextResponse.json(
      {
        error:
          'Standard Connect OAuth is no longer supported. Use mode "account_link" (Stripe Account Links).',
      },
      { status: 400 },
    );
  }
  if (modeRaw !== "account_link") {
    return NextResponse.json(
      { error: 'mode must be "account_link"' },
      { status: 400 },
    );
  }
  const mode = modeRaw as MerchantConnectMode;

  try {
    const result = await startMerchantConnect({
      clientId: auth.app.id,
      userId: auth.userId,
      mode,
      email: typeof body.email === "string" ? body.email : undefined,
      displayName:
        typeof body.displayName === "string" ? body.displayName : undefined,
    });
    return NextResponse.json(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(
      "[stripe-connect]",
      "startMerchantConnect failed:",
      sanitizeForLog(message),
    );
    const code = merchantConnectOAuthErrorCode(err);
    const status = code === "connect_misconfigured" ? 400 : 502;
    return NextResponse.json({ error: code }, { status });
  }
}
