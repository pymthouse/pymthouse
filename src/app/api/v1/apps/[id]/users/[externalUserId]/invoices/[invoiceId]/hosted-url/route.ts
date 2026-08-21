import { NextRequest, NextResponse } from "next/server";

import {
  authorizeAppUserBillingRoute,
  isAppUserBillingAccess,
} from "@/lib/billing/app-user-billing-route";
import { tryDecodeURIComponent } from "@/lib/billing-utils";
import {
  getHostedAdminClient,
  isHostedAdminClientAvailable,
} from "@/lib/openmeter/admin-client";
import { getAppBillingConfig } from "@/lib/openmeter/billing-profiles";
import { appUserPaymentMethodRequiresMerchantConnect } from "@/lib/openmeter/app-user-payment-method";
import { getAppUserInvoice } from "@/lib/openmeter/invoices";
import { retrievePlatformInvoiceLinks } from "@/lib/stripe/connect-accounts";
import { getMerchantConnectInvoiceLinksForAppUser } from "@/lib/stripe/merchant-connect";

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

  const decodedId = tryDecodeURIComponent(rawInvoiceId)?.trim() ?? "";
  if (!decodedId) {
    return NextResponse.json(
      { error: "Invoice id is required" },
      { status: 400 },
    );
  }

  try {
    const config = await getAppBillingConfig(access.app.id);
    const links = appUserPaymentMethodRequiresMerchantConnect(config)
      ? await getMerchantConnectInvoiceLinksForAppUser({
          clientId: access.app.id,
          externalUserId: access.externalUserId,
          invoiceId: decodedId,
        })
      : await getOwnerRollupInvoiceLinks({
          clientId: access.app.id,
          externalUserId: access.externalUserId,
          invoiceId: decodedId,
        });
    if (!links) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }
    if (!links.hostedInvoiceUrl && !links.invoicePdf) {
      return NextResponse.json(
        { error: "Stripe has no hosted page for this invoice." },
        { status: 404 },
      );
    }
    return NextResponse.json(links);
  } catch (err) {
    console.warn(
      "app-user-invoice-links: invoice lookup failed",
      err instanceof Error ? err.message : String(err),
    );
    return NextResponse.json({ error: "Billing unavailable" }, { status: 503 });
  }
}

async function getOwnerRollupInvoiceLinks(input: {
  clientId: string;
  externalUserId: string;
  invoiceId: string;
}): Promise<{ hostedInvoiceUrl: string | null; invoicePdf: string | null } | null> {
  if (!isHostedAdminClientAvailable()) {
    throw new Error("Billing unavailable");
  }
  const invoice = await getAppUserInvoice({
    client: getHostedAdminClient(),
    ...input,
  });
  if (!invoice?.externalInvoicingId?.trim()) {
    return null;
  }
  return retrievePlatformInvoiceLinks(invoice.externalInvoicingId);
}
