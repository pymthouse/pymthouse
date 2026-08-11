import { NextRequest, NextResponse } from "next/server";

import { loadAppUserBillingLedger } from "@/lib/billing/app-user-ledger";
import { authorizeOwnerWalletM2m } from "@/lib/billing/owner-wallet-m2m-auth";
import {
  readOptionalExternalUserId,
  resolveWalletBillingTarget,
} from "@/lib/billing/wallet-billing-target";
import { walletUpstreamErrorResponse } from "@/lib/billing/wallet-http";

/**
 * GET /api/v1/apps/{clientId}/billing/wallet/transactions
 *
 * Chronological prepaid ledger for a merchant-mode end-user wallet: credit
 * adds, derived usage drawdowns, and Connect invoices. Requires
 * `?externalUserId=` when `billingMode=merchant`.
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

  if (billingTarget.target.mode !== "merchant") {
    return NextResponse.json(
      {
        error:
          "Wallet transactions ledger is available for merchant end-user wallets",
      },
      { status: 400 },
    );
  }

  try {
    const result = await loadAppUserBillingLedger({
      appId: access.app.id,
      publicClientId: clientId,
      externalUserId: billingTarget.target.externalUserId,
    });
    return NextResponse.json({
      items: result.items,
      degraded: result.degraded,
    });
  } catch (err) {
    return walletUpstreamErrorResponse(err, "transaction ledger");
  }
}
