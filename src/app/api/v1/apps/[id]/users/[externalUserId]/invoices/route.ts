import { NextRequest, NextResponse } from "next/server";

import {
  authorizeAppUserBillingRoute,
  isAppUserBillingAccess,
} from "@/lib/billing/app-user-billing-route";
import { clampPageParam } from "@/lib/billing/wallet-http";
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
  const normalizedPage = clampPageParam(url.searchParams.get("page"), 1, 10_000);
  const normalizedPageSize = clampPageParam(
    url.searchParams.get("pageSize"),
    20,
    100,
  );

  // Fail open — same posture as payment-methods GET. Starter / sandbox users
  // often have no Stripe customer yet; list UI should show "none yet", not 503.
  try {
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
    return NextResponse.json({
      items: [],
      page: normalizedPage,
      pageSize: normalizedPageSize,
      totalCount: 0,
    });
  }
}

async function listOwnerRollupInvoices(input: {
  clientId: string;
  externalUserId: string;
  page: number;
  pageSize: number;
}) {
  if (!isHostedAdminClientAvailable()) {
    return {
      items: [],
      page: input.page,
      pageSize: input.pageSize,
      totalCount: 0,
    };
  }
  return listAppUserInvoices({
    client: getHostedAdminClient(),
    ...input,
  });
}
