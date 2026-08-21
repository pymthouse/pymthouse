import { NextRequest, NextResponse } from "next/server";

import {
  authorizeAppUserBillingRoute,
  isAppUserBillingAccess,
} from "@/lib/billing/app-user-billing-route";
import { listAppUserSubscriptionHistory } from "@/lib/openmeter/app-user-subscription-history";

/**
 * GET /api/v1/apps/{clientId}/users/{externalUserId}/subscriptions
 *
 * OpenMeter subscription supersession history for an app end-user (all statuses).
 * Auth: same as other app-user billing routes (`authorizeAppForBilling`).
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; externalUserId: string }> },
) {
  const { id: clientId, externalUserId: raw } = await params;
  const access = await authorizeAppUserBillingRoute(request, clientId, raw);
  if (!isAppUserBillingAccess(access)) {
    return access;
  }

  try {
    const result = await listAppUserSubscriptionHistory({
      clientId: access.app.id,
      externalUserId: access.externalUserId,
    });
    return NextResponse.json(result);
  } catch (err) {
    console.warn(
      "app-user-subscriptions: list failed",
      err instanceof Error ? err.message : String(err),
    );
    return NextResponse.json({
      items: [],
      externalUserId: access.externalUserId,
    });
  }
}
