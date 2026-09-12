import { NextRequest, NextResponse } from "next/server";

import {
  authorizeAppUserBillingRoute,
  isAppUserBillingAccess,
} from "@/lib/billing/app-user-billing-route";
import { listAppUserBillingInvoices } from "@/lib/billing/app-user-invoices-read";
import { clampPageParam } from "@/lib/billing/wallet-http";

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

  const result = await listAppUserBillingInvoices({
    appId: access.app.id,
    externalUserId: access.externalUserId,
    page: normalizedPage,
    pageSize: normalizedPageSize,
  });
  return NextResponse.json(result);
}
