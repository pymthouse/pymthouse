import { NextRequest, NextResponse } from "next/server";

import { authorizeOwnerWalletM2m } from "@/lib/billing/owner-wallet-m2m-auth";
import { clampPageParam, walletUpstreamErrorResponse } from "@/lib/billing/wallet-http";
import {
  getHostedAdminClient,
  isHostedAdminClientAvailable,
} from "@/lib/openmeter/admin-client";
import { listOwnerWalletInvoices } from "@/lib/openmeter/invoices";

/**
 * GET /api/v1/apps/{clientId}/billing/wallet/invoices — past platform
 * invoices on the owner's prepaid wallet (threshold charges, top-up
 * receipts issued as invoices, cycle reconciliations). Supports
 * `?page=` / `?pageSize=` (max 100).
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id: clientId } = await params;
  const access = await authorizeOwnerWalletM2m(request, clientId);
  if (!access) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  if (!isHostedAdminClientAvailable()) {
    return NextResponse.json(
      { error: "Billing is not available right now" },
      { status: 503 },
    );
  }

  const url = new URL(request.url);
  const page = clampPageParam(url.searchParams.get("page"), 1, 10_000);
  const pageSize = clampPageParam(url.searchParams.get("pageSize"), 20, 100);

  try {
    const result = await listOwnerWalletInvoices({
      client: getHostedAdminClient(),
      ownerUserId: access.ownerUserId,
      page,
      pageSize,
    });
    return NextResponse.json(result);
  } catch (err) {
    return walletUpstreamErrorResponse(err, "invoice list");
  }
}
