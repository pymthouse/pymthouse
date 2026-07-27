import { NextRequest, NextResponse } from "next/server";
import {
  canManageMerchantBilling,
  getAuthorizedProviderApp,
  merchantBillingForbiddenResponse,
} from "@/lib/provider-apps";
import { getHostedAdminClient } from "@/lib/openmeter/admin-client";
import { listTenantInvoices } from "@/lib/openmeter/invoices";
import { resolveOpenMeterMeterClientId } from "@/lib/openmeter/meter-client-id";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id: clientId } = await params;
  const auth = await getAuthorizedProviderApp(clientId, request);
  if (!auth) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const url = new URL(request.url);
  const page = Number(url.searchParams.get("page") || "1");
  const pageSize = Number(url.searchParams.get("pageSize") || "20");
  // Merchant Payments tab: end-user customers only. Owner-wallet invoices live
  // on platform /billing (pymthouse → developer). Opt in via includeOwnerWallet=1
  // (app owner / platform admin only — not provider team admins).
  const includeOwnerWalletRequested =
    url.searchParams.get("includeOwnerWallet") === "1" ||
    url.searchParams.get("includeOwnerWallet") === "true";
  if (
    includeOwnerWalletRequested &&
    !(await canManageMerchantBilling(auth))
  ) {
    return merchantBillingForbiddenResponse();
  }
  const includeOwnerWallet = includeOwnerWalletRequested;

  try {
    const client = getHostedAdminClient();
    // End-user keys are `{publicClientId}:{externalUserId}` — never developer_apps.id.
    const publicClientId = await resolveOpenMeterMeterClientId(auth.app.id);
    const result = await listTenantInvoices({
      client,
      clientId: publicClientId,
      page: Number.isFinite(page) ? page : 1,
      pageSize: Number.isFinite(pageSize) ? pageSize : 20,
      includeOwnerWallet,
    });
    return NextResponse.json(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: message }, { status: 503 });
  }
}
