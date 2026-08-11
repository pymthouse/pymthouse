import { NextRequest, NextResponse } from "next/server";

import { ingestTestUsageEvent } from "@/lib/billing/test-usage-event";
import { readJsonObjectBody } from "@/lib/billing/owner-wallet-m2m-auth";
import { walletUpstreamErrorResponse } from "@/lib/billing/wallet-http";
import { resolveWalletRouteContext } from "@/lib/billing/wallet-route-context";

/**
 * POST /api/v1/apps/{clientId}/billing/wallet/test-usage
 *
 * Demo helper: ingest a create_signed_ticket CloudEvent for the merchant
 * end-user with an exact USD fee, then optionally force mid-cycle invoice
 * collection so Custom Invoicing → settlement → Stripe Connect can be traced.
 *
 * Production safeguard: this route is disabled by default in production.
 * Operators enable it with `PYMTHOUSE_ENABLE_WALLET_TEST_USAGE=1`. Any
 * authenticated M2M caller that can reach the merchant wallet routes may use
 * it when enabled.
 *
 * Body: `{ "externalUserId": "eu_…", "amountUsd": "10.00", "collect"?: true }`
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id: clientId } = await params;
  const body = await readJsonObjectBody(request);
  const resolved = await resolveWalletRouteContext({
    request,
    clientId,
    externalUserId: body.externalUserId,
  });
  if (!resolved.ok) {
    return resolved.response;
  }

  const { target } = resolved.context;
  if (target.mode !== "merchant") {
    return NextResponse.json(
      { error: "test-usage is only available for merchant end-user wallets" },
      { status: 400 },
    );
  }

  if (
    process.env.NODE_ENV === "production" &&
    process.env.PYMTHOUSE_ENABLE_WALLET_TEST_USAGE !== "1"
  ) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const collect = body.collect !== false;

  try {
    const result = await ingestTestUsageEvent({
      publicClientId: clientId,
      externalUserId: target.externalUserId,
      amountUsd: body.amountUsd,
      collect,
    });
    return NextResponse.json(result, {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (/amountUsd/i.test(message)) {
      return NextResponse.json({ error: message }, { status: 400 });
    }
    return walletUpstreamErrorResponse(err, "test usage ingest");
  }
}
