import { NextRequest, NextResponse } from "next/server";

import { clampPageParam, walletUpstreamErrorResponse } from "@/lib/billing/wallet-http";
import { resolveWalletRouteContext } from "@/lib/billing/wallet-route-context";
import {
  getHostedAdminClient,
  isHostedAdminClientAvailable,
} from "@/lib/openmeter/admin-client";
import { listOwnerWalletInvoices } from "@/lib/openmeter/invoices";
import { listMerchantConnectInvoicesForAppUser } from "@/lib/stripe/merchant-connect";

/**
 * GET /api/v1/apps/{clientId}/billing/wallet/invoices — past invoices for the
 * resolved wallet target. Merchant mode lists Connect invoices for the
 * end-user; owner_rollup lists platform owner-wallet invoices.
 * Supports `?page=` / `?pageSize=` (max 100) and `?externalUserId=` (required
 * when `billingMode=merchant`).
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id: clientId } = await params;
  const searchParams = request.nextUrl.searchParams;
  const resolved = await resolveWalletRouteContext({
    request,
    clientId,
    externalUserId: searchParams.get("externalUserId"),
  });
  if (!resolved.ok) {
    return resolved.response;
  }

  const { app, target } = resolved.context;
  const page = clampPageParam(searchParams.get("page"), 1, 10_000);
  const pageSize = clampPageParam(searchParams.get("pageSize"), 20, 100);

  try {
    if (target.mode === "merchant") {
      const result = await listMerchantConnectInvoicesForAppUser({
        clientId: app.id,
        externalUserId: target.externalUserId,
        page,
        pageSize,
      });
      return NextResponse.json(result);
    }

    if (!isHostedAdminClientAvailable()) {
      return NextResponse.json(
        { error: "Billing is not available right now" },
        { status: 503 },
      );
    }

    const result = await listOwnerWalletInvoices({
      client: getHostedAdminClient(),
      ownerUserId: target.ownerUserId,
      page,
      pageSize,
    });
    return NextResponse.json(result);
  } catch (err) {
    return walletUpstreamErrorResponse(err, "invoice list");
  }
}
