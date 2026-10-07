import { NextRequest } from "next/server";

import { handleEndUserMeInvoiceHostedUrlGet } from "@/lib/billing/end-user-me-billing-handlers";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; invoiceId: string }> },
) {
  const { id, invoiceId } = await params;
  return handleEndUserMeInvoiceHostedUrlGet(request, id ?? "", invoiceId ?? "");
}
