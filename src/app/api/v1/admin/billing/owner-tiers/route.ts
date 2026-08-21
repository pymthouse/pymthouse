import { NextResponse } from "next/server";

import { withAdminGuard } from "@/lib/api-guards";
import {
  createOwnerSubscriptionTier,
  listOwnerSubscriptionTiers,
  toOwnerSubscriptionTierPublic,
  updateOwnerSubscriptionTier,
} from "@/lib/billing/owner-subscription-tiers";
import {
  readNullableStringField,
  readOptionalBooleanField,
  readOptionalNumberField,
  readRequiredStringField,
} from "@/lib/billing/owner-tier-body";
import { forceSyncOwnerPaidTier } from "@/lib/openmeter/owner-paid-plan";

/**
 * GET /api/v1/admin/billing/owner-tiers
 * List all Owner Paid subscription tiers (including inactive).
 */
export const GET = withAdminGuard(async () => {
  const tiers = await listOwnerSubscriptionTiers();
  return NextResponse.json({
    tiers: tiers.map(toOwnerSubscriptionTierPublic),
  });
});

/**
 * POST /api/v1/admin/billing/owner-tiers
 * Create a tier and force-sync it to OpenMeter.
 */
export const POST = withAdminGuard(async (request) => {
  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  try {
    if ("active" in body && typeof body.active !== "boolean") {
      return NextResponse.json(
        { error: "active must be a boolean when provided" },
        { status: 400 },
      );
    }
    const active = readOptionalBooleanField(body, "active") ?? true;

    const tier = await createOwnerSubscriptionTier({
      key: readRequiredStringField(body, "key"),
      name: readRequiredStringField(body, "name"),
      description: readNullableStringField(body, "description") ?? null,
      monthlyFeeUsd: readRequiredStringField(body, "monthlyFeeUsd"),
      includedUsdMicros: readRequiredStringField(body, "includedUsdMicros"),
      overageRateUsd: readNullableStringField(body, "overageRateUsd") ?? null,
      sortOrder: readOptionalNumberField(body, "sortOrder"),
      active,
    });

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
      const syncError = err instanceof Error ? err.message : String(err);
      // Keep failed syncs out of the Upgrade picker.
      const deactivated = await updateOwnerSubscriptionTier(tier.id, {
        active: false,
      });
      return NextResponse.json(
        {
          tier: toOwnerSubscriptionTierPublic(deactivated),
          synced: false,
          syncError,
        },
        { status: 502 },
      );
    }
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to create tier" },
      { status: 400 },
    );
  }
});
