import { NextRequest, NextResponse } from "next/server";

import { authorizeOwnerBillingM2m } from "@/lib/billing/owner-billing-m2m-auth";
import { getOwnerSubscriptionSwitchingStatus } from "@/lib/billing/owner-billing-m2m-status";

/**
 * GET /api/v1/apps/{clientId}/billing/owner-subscription
 *
 * Current owner-wallet plan, pending Starter downgrade, and payment-method
 * readiness for M2M integrators. Auth: M2M Basic only.
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id: clientId } = await params;
  const auth = await authorizeOwnerBillingM2m(request, clientId);
  if (!auth) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  try {
    const status = await getOwnerSubscriptionSwitchingStatus(auth.ownerUserId);
    return NextResponse.json(status);
  } catch (err) {
    console.error("Owner subscription status failed", err);
    return NextResponse.json(
      { error: "Failed to load owner subscription status" },
      { status: 502 },
    );
  }
}
