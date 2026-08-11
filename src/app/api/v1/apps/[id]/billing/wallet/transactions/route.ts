import { NextRequest, NextResponse } from "next/server";

import { loadAppUserBillingLedger } from "@/lib/billing/app-user-ledger";
import { walletUpstreamErrorResponse } from "@/lib/billing/wallet-http";
import { resolveWalletRouteContext } from "@/lib/billing/wallet-route-context";

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
  const resolved = await resolveWalletRouteContext({
    request,
    clientId,
    externalUserId: request.nextUrl.searchParams.get("externalUserId"),
  });
  if (!resolved.ok) {
    return resolved.response;
  }

  const { app, target } = resolved.context;
  if (target.mode !== "merchant") {
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
      appId: app.id,
      publicClientId: clientId,
      externalUserId: target.externalUserId,
    });
    return NextResponse.json({
      items: result.items,
      degraded: result.degraded,
    });
  } catch (err) {
    return walletUpstreamErrorResponse(err, "transaction ledger");
  }
}
