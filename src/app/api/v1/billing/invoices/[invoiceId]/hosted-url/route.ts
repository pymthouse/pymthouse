import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";

import { authOptions } from "@/lib/next-auth-options";
import {
  getHostedAdminClient,
  isHostedAdminClientAvailable,
} from "@/lib/openmeter/admin-client";
import { listOwnerWalletInvoices } from "@/lib/openmeter/invoices";
import { retrievePlatformInvoiceLinks } from "@/lib/stripe/connect-accounts";

/**
 * Resolve the Stripe hosted invoice page / PDF for one platform invoice.
 *
 * OpenMeter stores only the Stripe invoice id; the hosted URL is signed and
 * must be fetched from Stripe. Done on demand (one click = one lookup) rather
 * than for every row at page load.
 *
 * The invoice is re-resolved from the caller's own owner wallet, so a viewer
 * can never resolve an invoice id belonging to someone else.
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ invoiceId: string }> },
) {
  const { invoiceId } = await params;
  const session = await getServerSession(authOptions);
  const userId = (session?.user as Record<string, unknown> | undefined)?.id as
    | string
    | undefined;
  if (!userId?.trim()) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  if (!isHostedAdminClientAvailable()) {
    return NextResponse.json({ error: "Billing unavailable" }, { status: 503 });
  }

  const decodedId = decodeURIComponent(invoiceId).trim();
  if (!decodedId) {
    return NextResponse.json({ error: "Invoice id is required" }, { status: 400 });
  }

  const { items } = await listOwnerWalletInvoices({
    client: getHostedAdminClient(),
    ownerUserId: userId,
    page: 1,
    pageSize: 100,
  });

  const invoice = items.find((item) => item.id === decodedId);
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
    const links = await retrievePlatformInvoiceLinks(invoice.externalInvoicingId);
    if (!links.hostedInvoiceUrl && !links.invoicePdf) {
      return NextResponse.json(
        { error: "Stripe has no hosted page for this invoice." },
        { status: 404 },
      );
    }
    return NextResponse.json(links);
  } catch (err) {
    console.warn(
      "billing-invoice-links: Stripe lookup failed",
      err instanceof Error ? err.message : String(err),
    );
    return NextResponse.json({ error: "Invoice link unavailable" }, { status: 502 });
  }
}
