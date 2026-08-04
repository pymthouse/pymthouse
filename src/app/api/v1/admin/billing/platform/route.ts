import { NextResponse } from "next/server";

import { withSessionAdminGuard } from "@/lib/api-guards";
import { resolvePlatformOwnerStarterDefault } from "@/lib/billing/platform-owner-starter-default";
import { republishAndMigrateBaseOwnerStarter } from "@/lib/billing/republish-base-owner-starter";
import { OWNER_STARTER_PLAN_KEY } from "@/lib/openmeter/owner-starter-key";

/**
 * GET /api/v1/admin/billing/platform
 * Resolved Owner Starter platform default + source.
 */
export const GET = withSessionAdminGuard(async () => {
  const resolved = await resolvePlatformOwnerStarterDefault();
  return NextResponse.json({
    ownerStarterIncludedUsdMicros: resolved.ownerStarterIncludedUsdMicros,
    source: resolved.source,
    updatedBy: resolved.updatedBy,
    updatedAt: resolved.updatedAt,
    planKey: OWNER_STARTER_PLAN_KEY,
  });
});

/**
 * PATCH /api/v1/admin/billing/platform
 * Persist a new Owner Starter default and republish the base plan.
 * Pass `resync: true` to also migrate subscribers still on the shared base key.
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

  const resyncSubscribers = body.resync === true || body.resyncSubscribers === true;

  try {
    const result = await republishAndMigrateBaseOwnerStarter({
      ownerStarterIncludedUsdMicros: micros,
      updatedBy: context.userId,
      resyncSubscribers,
    });
    return NextResponse.json({
      ownerStarterIncludedUsdMicros: result.ownerStarterIncludedUsdMicros,
      source: "db" as const,
      planKey: result.planKey,
      openmeterPlanId: result.openmeterPlanId,
      resyncSubscribers: result.resyncSubscribers,
      migrate: result.migrate,
    });
  } catch {
    console.error("Admin platform billing PATCH failed");
    return NextResponse.json(
      { error: "Failed to update platform Owner Starter default" },
      { status: 500 },
    );
  }
});
