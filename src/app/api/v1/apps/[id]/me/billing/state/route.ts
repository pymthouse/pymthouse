import { NextRequest, NextResponse } from "next/server";

import { handleEndUserMeBillingStateGet } from "@/lib/billing/end-user-me-billing-handlers";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id: clientId } = await params;
  if (!clientId?.trim()) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  return handleEndUserMeBillingStateGet(request, clientId.trim());
}
