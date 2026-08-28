import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/db/index";
import { plans } from "@/db/schema";
import {
  canEditProviderApp,
  getAuthorizedProviderApp,
  appEditForbiddenResponse,
} from "@/lib/provider-apps";
import { syncPlanToOpenMeter } from "@/lib/openmeter/plans-sync";
import { invalidateStarterPlanSyncedCache } from "@/lib/openmeter/starter-subscription";
import {
  findConflictingPlanName,
  getOrCreateStarterPlan,
} from "@/lib/starter-default-plan";
import {
  STARTER_PLAN_DISABLED_STATUS,
  STARTER_PLAN_ENABLED_STATUS,
  planDisplayNameWithStarter,
} from "@/lib/starter-default-plan-display";
import { toPlanApiRow } from "@/lib/billing/product-dto";
import { resolvePlansDiscoveryForApp } from "@/lib/discovery-profile-resolve";
import {
  NETWORK_DEFAULT_PLAN_DISPLAY_NAME,
  NETWORK_DEFAULT_PLAN_INTERNAL_NAME,
} from "@/lib/network-default-plan-display";
import { validateCustomPlanName } from "@/lib/openmeter/plan-naming";

function isNonNegativeIntegerString(s: string): boolean {
  return /^\d+$/.test(s);
}

function parseIncludedUsdMicrosField(
  raw: unknown,
): { ok: true; value: string } | { ok: false; error: string } {
  if (raw === undefined || raw === null) {
    return { ok: false, error: "includedUsdMicros is required" };
  }
  let includedUsdMicros: string;
  if (typeof raw === "string") {
    includedUsdMicros = raw.trim();
  } else if (typeof raw === "number" && Number.isFinite(raw)) {
    includedUsdMicros = String(Math.trunc(raw));
  } else {
    return {
      ok: false,
      error: "includedUsdMicros must be a non-negative integer string",
    };
  }
  if (!isNonNegativeIntegerString(includedUsdMicros)) {
    return {
      ok: false,
      error: "includedUsdMicros must be a non-negative integer string",
    };
  }
  return { ok: true, value: includedUsdMicros };
}

function parseStarterStatusField(
  raw: unknown,
): { ok: true; value: string } | { ok: false; error: string } {
  if (typeof raw !== "string") {
    return {
      ok: false,
      error: `status must be "${STARTER_PLAN_ENABLED_STATUS}" or "${STARTER_PLAN_DISABLED_STATUS}"`,
    };
  }
  const status = raw.trim();
  if (
    status !== STARTER_PLAN_ENABLED_STATUS &&
    status !== STARTER_PLAN_DISABLED_STATUS
  ) {
    return {
      ok: false,
      error: `status must be "${STARTER_PLAN_ENABLED_STATUS}" or "${STARTER_PLAN_DISABLED_STATUS}"`,
    };
  }
  return { ok: true, value: status };
}

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id: clientId } = await params;
  const auth = await getAuthorizedProviderApp(clientId, request);
  if (!auth) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const starter = await getOrCreateStarterPlan(auth.app.id);
  const resolved = await resolvePlansDiscoveryForApp(auth.app.id);
  const row = resolved.find((r) => r.plan.id === starter.id);
  if (!row) {
    return NextResponse.json({ error: "Starter plan not found" }, { status: 404 });
  }

  const url = new URL(request.url);
  const includeInternals =
    url.searchParams.get("includeInternals") === "1" ||
    url.searchParams.get("includeInternals") === "true";

  return NextResponse.json({
    plan: toPlanApiRow({
      clientId: auth.app.id,
      resolved: {
        ...row,
        discoveryProfileId: row.discoveryProfileId ?? row.plan.discoveryProfileId,
      },
      includeInternals,
    }),
  });
}

export async function PUT(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id: clientId } = await params;
  const auth = await getAuthorizedProviderApp(clientId, request);
  if (!auth) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  if (!(await canEditProviderApp(auth))) {
    return appEditForbiddenResponse();
  }

  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON" }, { status: 400 });
  }

  const patch: {
    includedUsdMicros?: string;
    name?: string;
    status?: string;
    updatedAt: string;
  } = { updatedAt: new Date().toISOString() };

  if (body.includedUsdMicros !== undefined) {
    const parsed = parseIncludedUsdMicrosField(body.includedUsdMicros);
    if (!parsed.ok) {
      return NextResponse.json({ error: parsed.error }, { status: 400 });
    }
    patch.includedUsdMicros = parsed.value;
  }

  if (body.name !== undefined) {
    if (typeof body.name !== "string") {
      return NextResponse.json({ error: "name must be a string" }, { status: 400 });
    }
    const nameCheck = validateCustomPlanName(body.name);
    if (!nameCheck.ok) {
      return NextResponse.json({ error: nameCheck.error }, { status: 400 });
    }
    if (
      nameCheck.value === NETWORK_DEFAULT_PLAN_INTERNAL_NAME ||
      nameCheck.value === NETWORK_DEFAULT_PLAN_DISPLAY_NAME
    ) {
      return NextResponse.json(
        { error: "This plan name is reserved for the Network Price default plan" },
        { status: 400 },
      );
    }
    patch.name = nameCheck.value;
  }

  if (body.status !== undefined) {
    const parsed = parseStarterStatusField(body.status);
    if (!parsed.ok) {
      return NextResponse.json({ error: parsed.error }, { status: 400 });
    }
    patch.status = parsed.value;
  }

  if (
    patch.includedUsdMicros === undefined &&
    patch.name === undefined &&
    patch.status === undefined
  ) {
    return NextResponse.json(
      { error: "name, status, or includedUsdMicros is required" },
      { status: 400 },
    );
  }

  const starter = await getOrCreateStarterPlan(auth.app.id);

  if (patch.name) {
    const conflict = await findConflictingPlanName(
      auth.app.id,
      patch.name,
      starter.id,
    );
    if (conflict) {
      return NextResponse.json(
        { error: `A plan named "${patch.name}" already exists` },
        { status: 400 },
      );
    }
  }

  await db.update(plans).set(patch).where(eq(plans.id, starter.id));
  invalidateStarterPlanSyncedCache(auth.app.id);

  const sync = await syncPlanToOpenMeter(starter.id);
  const refreshed = await db.select().from(plans).where(eq(plans.id, starter.id)).limit(1);
  const next = refreshed[0];
  const displayName = next
    ? planDisplayNameWithStarter({
        name: next.name,
        isStarterDefault: true,
      })
    : patch.name;

  if (!sync.ok) {
    return NextResponse.json(
      {
        success: true,
        id: starter.id,
        name: displayName,
        status: next?.status ?? patch.status ?? starter.status,
        includedUsdMicros:
          next?.includedUsdMicros ?? patch.includedUsdMicros ?? starter.includedUsdMicros,
        syncError: sync.error,
      },
      { status: 200 },
    );
  }

  return NextResponse.json({
    success: true,
    id: starter.id,
    name: displayName,
    status: next?.status ?? patch.status ?? starter.status,
    includedUsdMicros:
      next?.includedUsdMicros ?? patch.includedUsdMicros ?? starter.includedUsdMicros,
    openmeterPlanId: sync.openmeterPlanId ?? next?.openmeterPlanId ?? null,
  });
}
