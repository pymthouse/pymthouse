import { NextRequest } from "next/server";

import {
  authorizeAppUserBillingRoute,
  isAppUserBillingAccess,
} from "@/lib/billing/app-user-billing-route";
import { appUserInvoiceLinksResponse } from "@/lib/billing/app-user-invoice-links";

/**
 * GET /api/v1/apps/{clientId}/users/{externalUserId}/invoices/{invoiceId}/hosted-url
 *
 * Resolve Stripe hosted invoice URL / PDF on the app's active billing plane.
 * Auth: `authorizeAppForBilling`.
 */
export async function GET(
  request: NextRequest,
  {
    params,
  }: {
    params: Promise<{
      id: string;
      externalUserId: string;
      invoiceId: string;
    }>;
  },
) {
  const {
    id: clientId,
    externalUserId: rawUser,
    invoiceId: rawInvoiceId,
  } = await params;
  const access = await authorizeAppUserBillingRoute(request, clientId, rawUser);
  if (!isAppUserBillingAccess(access)) {
    return access;
  }

  return appUserInvoiceLinksResponse({
    appId: access.app.id,
    externalUserId: access.externalUserId,
    rawInvoiceId,
  });
}
