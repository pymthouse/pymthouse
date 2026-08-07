import { NextRequest, NextResponse } from "next/server";

import {
  authorizeAppUserBillingRoute,
  isAppUserBillingAccess,
} from "@/lib/billing/app-user-billing-route";
import {
  getHostedAdminClient,
  isHostedAdminClientAvailable,
} from "@/lib/openmeter/admin-client";
import { getAppBillingConfig } from "@/lib/openmeter/billing-profiles";
import { appUserPaymentMethodRequiresMerchantConnect } from "@/lib/openmeter/app-user-payment-method";
import { listAppUserInvoices } from "@/lib/openmeter/invoices";
import { listMerchantConnectInvoicesForAppUser } from "@/lib/stripe/merchant-connect";

/**
 * GET /api/v1/apps/{clientId}/users/{externalUserId}/invoices
 *
 * End-user-scoped invoice list. Merchant apps read Connected Account invoices;
 * owner-rollup apps retain the OpenMeter customer list.
 * Auth: same as other app-user billing routes (`authorizeAppForBilling`).
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; externalUserId: string }> },
) {
  const { id: clientId, externalUserId: raw } = await params;
  const access = await authorizeAppUserBillingRoute(request, clientId, raw);
  if (!isAppUserBillingAccess(access)) {
    return access;
  }

  const url = new URL(request.url);
  const page = Number(url.searchParams.get("page") || "1");
  const pageSize = Number(url.searchParams.get("pageSize") || "20");

  try {
    const normalizedPage = Number.isFinite(page) && page > 0 ? page : 1;
    const normalizedPageSize =
      Number.isFinite(pageSize) && pageSize > 0 ? pageSize : 20;
    const config = await getAppBillingConfig(access.app.id);
    const result = appUserPaymentMethodRequiresMerchantConnect(config)
      ? await listMerchantConnectInvoicesForAppUser({
          clientId: access.app.id,
          externalUserId: access.externalUserId,
          page: normalizedPage,
          pageSize: normalizedPageSize,
        })
      : await listOwnerRollupInvoices({
          clientId: access.app.id,
          externalUserId: access.externalUserId,
          page: normalizedPage,
          pageSize: normalizedPageSize,
        });
    return NextResponse.json(result);
  } catch (err) {
    console.warn(
      "app-user-invoices: list failed",
      err instanceof Error ? err.message : String(err),
    );
    return NextResponse.json({ error: "Billing unavailable" }, { status: 503 });
  }
}

async function listOwnerRollupInvoices(input: {
  clientId: string;
  externalUserId: string;
  page: number;
  pageSize: number;
}) {
  if (!isHostedAdminClientAvailable()) {
    throw new Error("Billing unavailable");
  }
  return listAppUserInvoices({
    client: getHostedAdminClient(),
    ...input,
  });
}
