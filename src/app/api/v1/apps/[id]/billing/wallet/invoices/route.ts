import { NextRequest, NextResponse } from "next/server";

import { authorizeOwnerWalletM2m } from "@/lib/billing/owner-wallet-m2m-auth";
import {
  readOptionalExternalUserId,
  resolveWalletBillingTarget,
} from "@/lib/billing/wallet-billing-target";
import { clampPageParam, walletUpstreamErrorResponse } from "@/lib/billing/wallet-http";
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
  const access = await authorizeOwnerWalletM2m(request, clientId);
  if (!access) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const url = new URL(request.url);
  const billingTarget = await resolveWalletBillingTarget({
    appId: access.app.id,
    ownerUserId: access.ownerUserId,
    externalUserId: readOptionalExternalUserId(
      url.searchParams.get("externalUserId"),
    ),
  });
  if (!billingTarget.ok) {
    return NextResponse.json(
      { error: billingTarget.error },
      { status: billingTarget.status },
    );
  }

  const page = clampPageParam(url.searchParams.get("page"), 1, 10_000);
  const pageSize = clampPageParam(url.searchParams.get("pageSize"), 20, 100);

  try {
    if (billingTarget.target.mode === "merchant") {
      const result = await listMerchantConnectInvoicesForAppUser({
        clientId: access.app.id,
        externalUserId: billingTarget.target.externalUserId,
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
      ownerUserId: billingTarget.target.ownerUserId,
      page,
      pageSize,
    });
    return NextResponse.json(result);
  } catch (err) {
    return walletUpstreamErrorResponse(err, "invoice list");
  }
}
