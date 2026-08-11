import { NextRequest, NextResponse } from "next/server";

import { ingestTestUsageEvent } from "@/lib/billing/test-usage-event";
import {
  authorizeOwnerWalletM2m,
  readJsonObjectBody,
} from "@/lib/billing/owner-wallet-m2m-auth";
import {
  readOptionalExternalUserId,
  resolveWalletBillingTarget,
} from "@/lib/billing/wallet-billing-target";
import { walletUpstreamErrorResponse } from "@/lib/billing/wallet-http";

/**
 * POST /api/v1/apps/{clientId}/billing/wallet/test-usage
 *
 * Demo helper: ingest a create_signed_ticket CloudEvent for the merchant
 * end-user with an exact USD fee, then optionally force mid-cycle invoice
 * collection so Custom Invoicing → settlement → Stripe Connect can be traced.
 *
 * Body: `{ "externalUserId": "eu_…", "amountUsd": "10.00", "collect"?: true }`
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id: clientId } = await params;
  const access = await authorizeOwnerWalletM2m(request, clientId);
  if (!access) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const body = await readJsonObjectBody(request);
  const billingTarget = await resolveWalletBillingTarget({
    appId: access.app.id,
    ownerUserId: access.ownerUserId,
    externalUserId: readOptionalExternalUserId(body.externalUserId),
  });
  if (!billingTarget.ok) {
    return NextResponse.json(
      { error: billingTarget.error },
      { status: billingTarget.status },
    );
  }

  if (billingTarget.target.mode !== "merchant") {
    return NextResponse.json(
      { error: "test-usage is only available for merchant end-user wallets" },
      { status: 400 },
    );
  }

  const collect = body.collect !== false;

  try {
    const result = await ingestTestUsageEvent({
      publicClientId: clientId,
      externalUserId: billingTarget.target.externalUserId,
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
