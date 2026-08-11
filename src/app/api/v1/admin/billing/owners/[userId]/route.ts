import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";

import { db } from "@/db/index";
import { users } from "@/db/schema";
import { withSessionAdminGuardParams } from "@/lib/api-guards";
import {
  getOwnerBillingOverrides,
  resolveOwnerBilling,
  setOwnerBillingOverrides,
} from "@/lib/billing/owner-billing-config";
import { parseOwnerBillingPatchBody } from "@/lib/billing/owner-billing-patch";
import { resolvePlatformOwnerStarterIncludedUsdMicros } from "@/lib/billing/platform-owner-starter-default";
import { isHostedAdminClientAvailable } from "@/lib/openmeter/admin-client";
import { ownerStarterPlanKeyForAmount } from "@/lib/openmeter/owner-starter-key";
import {
  ensureOwnerStarterSubscription,
  invalidateOwnerStarterPlanCache,
} from "@/lib/openmeter/owner-starter-plan";

async function loadOwnerUser(userId: string) {
  const rows = await db
    .select({
      id: users.id,
      email: users.email,
      name: users.name,
      role: users.role,
    })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  return rows[0] ?? null;
}

/**
 * GET /api/v1/admin/billing/owners/[userId]
 */
export const GET = withSessionAdminGuardParams<{ userId: string }>(
  async (_request, routeContext) => {
    const { userId } = await routeContext.params;
    const owner = await loadOwnerUser(userId);
    if (!owner) {
      return NextResponse.json({ error: "Owner not found" }, { status: 404 });
    }

    const [overrides, resolved, platformDefault] = await Promise.all([
      getOwnerBillingOverrides(userId),
      resolveOwnerBilling(userId),
      resolvePlatformOwnerStarterIncludedUsdMicros(),
    ]);

    return NextResponse.json({
      owner,
      overrides,
      resolved,
      planKey: ownerStarterPlanKeyForAmount(
        resolved.starterIncludedUsdMicros,
        platformDefault,
      ),
      platformDefault: {
        starterIncludedUsdMicros: platformDefault,
      },
    });
  },
);

/**
 * PATCH /api/v1/admin/billing/owners/[userId]
 * Upsert cost-rail overrides and ensure the Owner Starter subscription.
 */
export const PATCH = withSessionAdminGuardParams<{ userId: string }>(
  async (request, routeContext, context) => {
    const { userId } = await routeContext.params;
    const owner = await loadOwnerUser(userId);
    if (!owner) {
      return NextResponse.json({ error: "Owner not found" }, { status: 404 });
    }
    if (owner.role !== "developer" && owner.role !== "admin") {
      return NextResponse.json(
        { error: "Owner must be a developer or admin account" },
        { status: 400 },
      );
    }

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
    }

    const parsed = parseOwnerBillingPatchBody(body);
    if (!parsed.ok) {
      return NextResponse.json({ error: parsed.error }, { status: 400 });
    }

    try {
      await setOwnerBillingOverrides({
        ownerUserId: userId,
        ...parsed.patch,
        updatedBy: context.userId,
      });
      invalidateOwnerStarterPlanCache();

      const subscription = isHostedAdminClientAvailable()
        ? await ensureOwnerStarterSubscription({ ownerUserId: userId })
        : null;

      const [overrides, resolved, platformDefault] = await Promise.all([
        getOwnerBillingOverrides(userId),
        resolveOwnerBilling(userId),
        resolvePlatformOwnerStarterIncludedUsdMicros(),
      ]);

      return NextResponse.json({
        owner,
        overrides,
        resolved,
        planKey: ownerStarterPlanKeyForAmount(
          resolved.starterIncludedUsdMicros,
          platformDefault,
        ),
        subscription,
      });
    } catch {
      console.error("Admin owner billing PATCH failed");
      return NextResponse.json(
        { error: "Failed to update owner billing overrides" },
        { status: 500 },
      );
    }
  },
);
