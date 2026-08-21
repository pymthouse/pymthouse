import { NextRequest, NextResponse } from "next/server";
import {
  canManageMerchantBilling,
  getAuthorizedProviderApp,
  merchantBillingForbiddenResponse,
} from "@/lib/provider-apps";
import { getAppOpenMeterConfigRow } from "@/lib/openmeter/client-factory";
import { sanitizeForLog } from "@/lib/sanitize-for-log";
import { refreshMerchantAccountLink } from "@/lib/stripe/merchant-connect";
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

  try {
    const result = await refreshMerchantAccountLink(auth.app.id);
    return NextResponse.json(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(
      "[stripe-account-link]",
      "refreshMerchantAccountLink failed:",
      sanitizeForLog(message),
    );
    return NextResponse.json(
      { error: merchantConnectOAuthErrorCode(err) },
      { status: 400 },
    );
  }
}
