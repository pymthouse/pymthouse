import { NextResponse } from "next/server";

import { tryDecodeURIComponent } from "@/lib/billing-utils";
import {
  getHostedAdminClient,
  isHostedAdminClientAvailable,
} from "@/lib/openmeter/admin-client";
import { appUserPaymentMethodRequiresMerchantConnect } from "@/lib/openmeter/app-user-payment-method";
import { getAppBillingConfig } from "@/lib/openmeter/billing-profiles";
import { getAppUserInvoice } from "@/lib/openmeter/invoices";
import { retrievePlatformInvoiceLinks } from "@/lib/stripe/connect-accounts";
import { getMerchantConnectInvoiceLinksForAppUser } from "@/lib/stripe/merchant-connect";

type InvoiceLinks = { hostedInvoiceUrl: string | null; invoicePdf: string | null };

async function getOwnerRollupInvoiceLinks(input: {
  clientId: string;
  externalUserId: string;
  invoiceId: string;
}): Promise<InvoiceLinks | null> {
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

/**
 * Stripe hosted invoice URL / PDF for one of the app user's invoices, on the
 * app's active billing plane. Both lookups only return an invoice owned by
 * that user's customer — anything else is 404.
 */
export async function appUserInvoiceLinksResponse(input: {
  /** `developer_apps.id`. */
  appId: string;
  externalUserId: string;
  /** Raw (still URL-encoded) path segment. */
  rawInvoiceId: string;
}): Promise<Response> {
  const invoiceId = tryDecodeURIComponent(input.rawInvoiceId)?.trim() ?? "";
  if (!invoiceId) {
    return NextResponse.json({ error: "Invoice id is required" }, { status: 400 });
  }

  try {
    const config = await getAppBillingConfig(input.appId);
    const lookup = {
      clientId: input.appId,
      externalUserId: input.externalUserId,
      invoiceId,
    };
    const links = appUserPaymentMethodRequiresMerchantConnect(config)
      ? await getMerchantConnectInvoiceLinksForAppUser(lookup)
      : await getOwnerRollupInvoiceLinks(lookup);
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
