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
import { getAppUserInvoice } from "@/lib/openmeter/invoices";
import { retrievePlatformInvoiceLinks } from "@/lib/stripe/connect-accounts";

/**
 * GET /api/v1/apps/{clientId}/users/{externalUserId}/invoices/{invoiceId}/hosted-url
 *
 * Resolve Stripe hosted invoice URL / PDF for one invoice belonging to this
 * app user. Auth: `authorizeAppForBilling`.
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

  if (!isHostedAdminClientAvailable()) {
    return NextResponse.json({ error: "Billing unavailable" }, { status: 503 });
  }

  const decodedId = tryDecodeURIComponent(rawInvoiceId)?.trim() ?? "";
  if (!decodedId) {
    return NextResponse.json(
      { error: "Invoice id is required" },
      { status: 400 },
    );
  }

  let invoice;
  try {
    invoice = await getAppUserInvoice({
      client: getHostedAdminClient(),
      clientId: access.app.id,
      externalUserId: access.externalUserId,
      invoiceId: decodedId,
    });
  } catch (err) {
    console.warn(
      "app-user-invoice-links: invoice lookup failed",
      err instanceof Error ? err.message : String(err),
    );
    return NextResponse.json({ error: "Billing unavailable" }, { status: 503 });
  }
  if (!invoice) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  if (!invoice.externalInvoicingId?.trim()) {
    return NextResponse.json(
      { error: "This invoice has no Stripe record yet." },
      { status: 404 },
    );
  }

  try {
    const links = await retrievePlatformInvoiceLinks(
      invoice.externalInvoicingId,
    );
    if (!links.hostedInvoiceUrl && !links.invoicePdf) {
      return NextResponse.json(
        { error: "Stripe has no hosted page for this invoice." },
        { status: 404 },
      );
    }
    return NextResponse.json(links);
  } catch (err) {
    console.warn(
      "app-user-invoice-links: Stripe lookup failed",
      err instanceof Error ? err.message : String(err),
    );
    return NextResponse.json(
      { error: "Invoice link unavailable" },
      { status: 502 },
    );
  }
}
