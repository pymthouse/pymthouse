import { NextResponse } from "next/server";

import { withSessionAdminGuard } from "@/lib/api-guards";
import {
  normalizeOwnerStarterPlanName,
  resolvePlatformOwnerStarterDefault,
} from "@/lib/billing/platform-owner-starter-default";
import { republishPlatformOwnerAllowancePlans } from "@/lib/billing/republish-platform-owner-allowance-plans";
import { readOptionalStringField } from "@/lib/billing/owner-tier-body";
import {
  OWNER_PAID_PLAN_KEY,
  peekOwnerPaidPlanPublished,
} from "@/lib/openmeter/owner-paid-plan";
import { OWNER_STARTER_PLAN_KEY } from "@/lib/openmeter/owner-starter-key";

/**
 * GET /api/v1/admin/billing/platform
 * Resolved Owner Starter platform default + Owner Paid published snapshot.
 */
export const GET = withSessionAdminGuard(async () => {
  const resolved = await resolvePlatformOwnerStarterDefault();
  const paid = await peekOwnerPaidPlanPublished();
  return NextResponse.json({
    ownerStarterIncludedUsdMicros: resolved.ownerStarterIncludedUsdMicros,
    ownerStarterPlanName: resolved.ownerStarterPlanName,
    source: resolved.source,
    updatedBy: resolved.updatedBy,
    updatedAt: resolved.updatedAt,
    planKey: OWNER_STARTER_PLAN_KEY,
    ownerPaidPlanKey: paid.planKey || OWNER_PAID_PLAN_KEY,
    ownerPaidOpenmeterPlanId: paid.openmeterPlanId,
    ownerPaidIncludedUsdMicros: paid.publishedIncludedUsdMicros,
  });
});

/**
 * PATCH /api/v1/admin/billing/platform
 * Persist a new Developer wallet default and republish Owner Starter + Owner Paid.
 * Pass `resync: true` to also migrate subscribers still on the shared Starter base key.
 */
export const PATCH = withSessionAdminGuard(async (request, context) => {
  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const raw = body.ownerStarterIncludedUsdMicros;
  let micros: string | null = null;
  if (typeof raw === "string") {
    micros = raw.trim();
  } else if (typeof raw === "number" && Number.isFinite(raw)) {
    micros = String(Math.trunc(raw));
  }

  if (!micros || !/^\d+$/.test(micros)) {
    return NextResponse.json(
      { error: "ownerStarterIncludedUsdMicros must be a non-negative integer string" },
      { status: 400 },
    );
  }

  const nameRaw = readOptionalStringField(body, "ownerStarterPlanName");
  let ownerStarterPlanName: string | undefined;
  if (nameRaw !== undefined) {
    try {
      ownerStarterPlanName = normalizeOwnerStarterPlanName(nameRaw);
    } catch (err) {
      return NextResponse.json(
        { error: err instanceof Error ? err.message : String(err) },
        { status: 400 },
      );
    }
  }

  const resyncSubscribers = body.resync === true || body.resyncSubscribers === true;

  try {
    const result = await republishPlatformOwnerAllowancePlans({
      ownerStarterIncludedUsdMicros: micros,
      ownerStarterPlanName,
      updatedBy: context.userId,
      resyncSubscribers,
    });
    return NextResponse.json({
      ownerStarterIncludedUsdMicros: result.ownerStarterIncludedUsdMicros,
      ownerStarterPlanName: result.ownerStarterPlanName,
      source: "db" as const,
      planKey: result.planKey,
      openmeterPlanId: result.openmeterPlanId,
      ownerPaidPlanKey: result.ownerPaidPlanKey,
      ownerPaidOpenmeterPlanId: result.ownerPaidOpenmeterPlanId,
      ownerPaidIncludedUsdMicros: result.ownerPaidIncludedUsdMicros,
      resyncSubscribers: result.resyncSubscribers,
      migrate: result.migrate,
      warnings: result.warnings,
    });
  } catch {
    console.error("Admin platform billing PATCH failed");
    return NextResponse.json(
      { error: "Failed to update platform Owner Starter default" },
      { status: 500 },
    );
  }
});
