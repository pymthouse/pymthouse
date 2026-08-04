import { NextResponse } from "next/server";

import { withSessionAdminGuardParams } from "@/lib/api-guards";
import {
  deactivateOwnerSubscriptionTier,
  getOwnerSubscriptionTierById,
  toOwnerSubscriptionTierPublic,
  updateOwnerSubscriptionTier,
} from "@/lib/billing/owner-subscription-tiers";
import { forceSyncOwnerPaidTier } from "@/lib/openmeter/owner-paid-plan";

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
      const tier = await updateOwnerSubscriptionTier(id, {
        name: typeof body.name === "string" ? body.name : undefined,
        description:
          body.description === undefined
            ? undefined
            : body.description === null
              ? null
              : String(body.description),
        monthlyFeeUsd:
          body.monthlyFeeUsd === undefined
            ? undefined
            : String(body.monthlyFeeUsd),
        includedUsdMicros:
          body.includedUsdMicros === undefined
            ? undefined
            : String(body.includedUsdMicros),
        overageRateUsd:
          body.overageRateUsd === undefined
            ? undefined
            : body.overageRateUsd === null
              ? null
              : String(body.overageRateUsd),
        sortOrder:
          typeof body.sortOrder === "number" ? body.sortOrder : undefined,
        active: typeof body.active === "boolean" ? body.active : undefined,
      });

      const shouldSync =
        body.monthlyFeeUsd !== undefined ||
        body.includedUsdMicros !== undefined ||
        body.overageRateUsd !== undefined ||
        body.sync === true;

      if (shouldSync && tier.active === 1) {
        try {
          const synced = await forceSyncOwnerPaidTier(tier);
          const refreshed = await getOwnerSubscriptionTierById(tier.id);
          return NextResponse.json({
            tier: toOwnerSubscriptionTierPublic(refreshed ?? tier),
            synced: true,
            openmeterPlanId: synced.openmeterPlanId,
          });
        } catch (err) {
          return NextResponse.json({
            tier: toOwnerSubscriptionTierPublic(tier),
            synced: false,
            syncError: err instanceof Error ? err.message : String(err),
          });
        }
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
