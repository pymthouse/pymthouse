import { NextRequest, NextResponse } from "next/server";

import { authorizeOwnerBillingM2m } from "@/lib/billing/owner-billing-m2m-auth";
import {
  listSelectableOwnerSubscriptionTiers,
  toOwnerSubscriptionTierPublic,
} from "@/lib/billing/owner-subscription-tiers";

/**
 * GET /api/v1/apps/{clientId}/billing/owner-tiers
 *
 * List selectable Owner Paid tiers for M2M-driven Upgrade / Change plan.
 * Auth: M2M Basic only (app owner wallet).
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

  const tiers = await listSelectableOwnerSubscriptionTiers();
  return NextResponse.json({
    tiers: tiers.map(toOwnerSubscriptionTierPublic),
  });
}
