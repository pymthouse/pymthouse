import { NextResponse } from "next/server";

import { withSessionAdminGuard } from "@/lib/api-guards";
import {
  createOwnerSubscriptionTier,
  listOwnerSubscriptionTiers,
  toOwnerSubscriptionTierPublic,
} from "@/lib/billing/owner-subscription-tiers";
import { forceSyncOwnerPaidTier } from "@/lib/openmeter/owner-paid-plan";

/**
 * GET /api/v1/admin/billing/owner-tiers
 * List all Owner Paid subscription tiers (including inactive).
 */
export const GET = withSessionAdminGuard(async () => {
  const tiers = await listOwnerSubscriptionTiers();
  return NextResponse.json({
    tiers: tiers.map(toOwnerSubscriptionTierPublic),
  });
});

/**
 * POST /api/v1/admin/billing/owner-tiers
 * Create a tier and force-sync it to OpenMeter.
 */
export const POST = withSessionAdminGuard(async (request) => {
  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  try {
    const tier = await createOwnerSubscriptionTier({
      key: String(body.key ?? ""),
      name: String(body.name ?? ""),
      description:
        body.description === undefined || body.description === null
          ? null
          : String(body.description),
      monthlyFeeUsd: String(body.monthlyFeeUsd ?? ""),
      includedUsdMicros: String(body.includedUsdMicros ?? ""),
      overageRateUsd:
        body.overageRateUsd === undefined || body.overageRateUsd === null
          ? null
          : String(body.overageRateUsd),
      sortOrder:
        typeof body.sortOrder === "number" ? body.sortOrder : undefined,
      active: body.active === false ? false : true,
    });

    let syncError: string | null = null;
    try {
      const synced = await forceSyncOwnerPaidTier(tier);
      return NextResponse.json({
        tier: toOwnerSubscriptionTierPublic({
          ...tier,
          openmeterPlanId: synced.openmeterPlanId,
          lastSyncedAt: new Date().toISOString(),
        }),
        synced: true,
      });
    } catch (err) {
      syncError = err instanceof Error ? err.message : String(err);
      return NextResponse.json(
        {
          tier: toOwnerSubscriptionTierPublic(tier),
          synced: false,
          syncError,
        },
        { status: 201 },
      );
    }
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to create tier" },
      { status: 400 },
    );
  }
});
