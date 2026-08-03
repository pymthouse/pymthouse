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
import { resolvePlatformOwnerStarterIncludedUsdMicros } from "@/lib/billing/platform-owner-starter-default";
import {
  ownerStarterPlanKeyForAmount,
} from "@/lib/openmeter/owner-starter-key";
import {
  ensureOwnerStarterSubscription,
  invalidateOwnerStarterPlanCache,
} from "@/lib/openmeter/owner-starter-plan";
import { isHostedAdminClientAvailable } from "@/lib/openmeter/admin-client";

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

    let body: Record<string, unknown>;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
    }

    const patch: {
      starterIncludedUsdMicros?: string | null;
      endUserCap?: number | null;
      applicationFeeBps?: number | null;
      note?: string | null;
    } = {};

    if ("starterIncludedUsdMicros" in body) {
      const raw = body.starterIncludedUsdMicros;
      if (raw === null) {
        patch.starterIncludedUsdMicros = null;
      } else if (typeof raw === "string") {
        const trimmed = raw.trim();
        if (trimmed && !/^\d+$/.test(trimmed)) {
          return NextResponse.json(
            { error: "starterIncludedUsdMicros must be a non-negative integer string or null" },
            { status: 400 },
          );
        }
        patch.starterIncludedUsdMicros = trimmed || null;
      } else if (typeof raw === "number" && Number.isFinite(raw)) {
        patch.starterIncludedUsdMicros = String(Math.trunc(raw));
      } else {
        return NextResponse.json(
          { error: "starterIncludedUsdMicros must be a non-negative integer string or null" },
          { status: 400 },
        );
      }
    }

    if ("endUserCap" in body) {
      if (body.endUserCap === null) {
        patch.endUserCap = null;
      } else if (
        typeof body.endUserCap === "number" &&
        Number.isInteger(body.endUserCap) &&
        body.endUserCap > 0
      ) {
        patch.endUserCap = body.endUserCap;
      } else {
        return NextResponse.json(
          { error: "endUserCap must be a positive integer or null" },
          { status: 400 },
        );
      }
    }

    if ("applicationFeeBps" in body) {
      if (body.applicationFeeBps === null) {
        patch.applicationFeeBps = null;
      } else if (
        typeof body.applicationFeeBps === "number" &&
        Number.isInteger(body.applicationFeeBps) &&
        body.applicationFeeBps >= 0 &&
        body.applicationFeeBps <= 10_000
      ) {
        patch.applicationFeeBps = body.applicationFeeBps;
      } else {
        return NextResponse.json(
          { error: "applicationFeeBps must be an integer in [0, 10000] or null" },
          { status: 400 },
        );
      }
    }

    if ("note" in body) {
      if (body.note === null) {
        patch.note = null;
      } else if (typeof body.note === "string") {
        patch.note = body.note;
      } else {
        return NextResponse.json(
          { error: "note must be a string or null" },
          { status: 400 },
        );
      }
    }

    if (Object.keys(patch).length === 0) {
      return NextResponse.json(
        { error: "No recognized fields to update" },
        { status: 400 },
      );
    }

    try {
      await setOwnerBillingOverrides({
        ownerUserId: userId,
        ...patch,
        updatedBy: context.userId,
      });
      invalidateOwnerStarterPlanCache();

      let subscription: {
        openmeterSubscriptionId: string | null;
        planKey: string;
        openmeterPlanId: string;
        created: boolean;
      } | null = null;

      if (isHostedAdminClientAvailable()) {
        subscription = await ensureOwnerStarterSubscription({
          ownerUserId: userId,
        });
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
        subscription,
      });
    } catch (err) {
      console.error("Admin owner billing PATCH failed:", err);
      return NextResponse.json(
        {
          error:
            err instanceof Error
              ? err.message
              : "Failed to update owner billing overrides",
        },
        { status: 500 },
      );
    }
  },
);
