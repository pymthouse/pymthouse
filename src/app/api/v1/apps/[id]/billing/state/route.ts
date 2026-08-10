import { NextRequest, NextResponse } from "next/server";

import { loadBillingState } from "@/lib/billing/billing-state-read";
import { authorizeOwnerWalletM2m } from "@/lib/billing/owner-wallet-m2m-auth";
import {
  readOptionalExternalUserId,
  resolveWalletBillingTarget,
} from "@/lib/billing/wallet-billing-target";

/**
 * GET /api/v1/apps/{clientId}/billing/state — canonical spend posture for a
 * subject: whether it can spend, how much room is left, and what happens next.
 *
 * Merchant apps require `externalUserId`; owner rollup apps may pass one to
 * scope unbilled debt to a single subject.
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

  const externalUserId = readOptionalExternalUserId(
    request.nextUrl.searchParams.get("externalUserId"),
  );
  const billingTarget = await resolveWalletBillingTarget({
    appId: access.app.id,
    ownerUserId: access.ownerUserId,
    externalUserId,
  });
  if (!billingTarget.ok) {
    return NextResponse.json(
      { error: billingTarget.error },
      { status: billingTarget.status },
    );
  }

  const state = await loadBillingState({
    publicClientId: clientId,
    appId: access.app.id,
    target: billingTarget.target,
    externalUserId,
  });

  return NextResponse.json(state, {
    headers: { "Cache-Control": "no-store" },
  });
}
