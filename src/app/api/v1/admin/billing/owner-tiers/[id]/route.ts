import { NextResponse } from "next/server";

import { withSessionAdminGuardParams } from "@/lib/api-guards";
import {
  deactivateOwnerSubscriptionTier,
  getOwnerSubscriptionTierById,
  toOwnerSubscriptionTierPublic,
  updateOwnerSubscriptionTier,
  type OwnerSubscriptionTierRow,
  type UpdateOwnerSubscriptionTierInput,
} from "@/lib/billing/owner-subscription-tiers";
import {
  readNullableStringField,
  readOptionalBooleanField,
  readOptionalNumberField,
  readOptionalStringField,
} from "@/lib/billing/owner-tier-body";
import { forceSyncOwnerPaidTier } from "@/lib/openmeter/owner-paid-plan";

function patchFromBody(body: Record<string, unknown>): UpdateOwnerSubscriptionTierInput {
  return {
    name: readOptionalStringField(body, "name"),
    description: readNullableStringField(body, "description"),
    monthlyFeeUsd: readOptionalStringField(body, "monthlyFeeUsd"),
    includedUsdMicros: readOptionalStringField(body, "includedUsdMicros"),
    overageRateUsd: readNullableStringField(body, "overageRateUsd"),
    sortOrder: readOptionalNumberField(body, "sortOrder"),
    active: readOptionalBooleanField(body, "active"),
  };
}

function shouldSyncTier(body: Record<string, unknown>): boolean {
  return (
    body.monthlyFeeUsd !== undefined ||
    body.includedUsdMicros !== undefined ||
    body.overageRateUsd !== undefined ||
    body.sync === true
  );
}

async function syncTierResponse(
  tier: OwnerSubscriptionTierRow,
): Promise<NextResponse> {
  try {
    const synced = await forceSyncOwnerPaidTier(tier);
    const refreshed = await getOwnerSubscriptionTierById(tier.id);
    return NextResponse.json({
      tier: toOwnerSubscriptionTierPublic(refreshed ?? tier),
      synced: true,
      openmeterPlanId: synced.openmeterPlanId,
    });
  } catch (err) {
    return NextResponse.json(
      {
        tier: toOwnerSubscriptionTierPublic(tier),
        synced: false,
        syncError: err instanceof Error ? err.message : String(err),
      },
      { status: 502 },
    );
  }
}

/**
 * PATCH /api/v1/admin/billing/owner-tiers/[id]
 * Update a tier and re-sync to OpenMeter when pricing/allowance changes.
 */
export const PATCH = withSessionAdminGuardParams<{ id: string }>(
  async (request, routeContext) => {
    const { id } = await routeContext.params;
    let body: Record<string, unknown>;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
    }

    try {
      const tier = await updateOwnerSubscriptionTier(id, patchFromBody(body));
      if (shouldSyncTier(body) && tier.active === 1) {
        return syncTierResponse(tier);
      }
      return NextResponse.json({
        tier: toOwnerSubscriptionTierPublic(tier),
        synced: false,
      });
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Failed to update tier";
      const status = message.includes("not found") ? 404 : 400;
      return NextResponse.json({ error: message }, { status });
    }
  },
);

/**
 * DELETE /api/v1/admin/billing/owner-tiers/[id]
 * Soft-deactivate (does not delete OM plan or active subscribers).
 */
export const DELETE = withSessionAdminGuardParams<{ id: string }>(
  async (_request, routeContext) => {
    const { id } = await routeContext.params;
    try {
      const tier = await deactivateOwnerSubscriptionTier(id);
      return NextResponse.json({
        tier: toOwnerSubscriptionTierPublic(tier),
      });
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Failed to deactivate tier";
      const status = message.includes("not found") ? 404 : 400;
      return NextResponse.json({ error: message }, { status });
    }
  },
);
