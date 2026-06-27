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
import { getOrCreateStarterPlan } from "@/lib/starter-default-plan";
import { toPlanApiRow } from "@/lib/billing/product-dto";
import { resolvePlansDiscoveryForApp } from "@/lib/discovery-profile-resolve";

function isNonNegativeIntegerString(s: string): boolean {
  return /^\d+$/.test(s);
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

  const raw = body.includedUsdMicros;
  if (raw === undefined || raw === null) {
    return NextResponse.json(
      { error: "includedUsdMicros is required" },
      { status: 400 },
    );
  }
  let includedUsdMicros: string;
  if (typeof raw === "string") {
    includedUsdMicros = raw.trim();
  } else if (typeof raw === "number" && Number.isFinite(raw)) {
    includedUsdMicros = String(Math.trunc(raw));
  } else {
    return NextResponse.json(
      { error: "includedUsdMicros must be a non-negative integer string" },
      { status: 400 },
    );
  }
  if (!isNonNegativeIntegerString(includedUsdMicros)) {
    return NextResponse.json(
      { error: "includedUsdMicros must be a non-negative integer string" },
      { status: 400 },
    );
  }

  const starter = await getOrCreateStarterPlan(auth.app.id);
  const now = new Date().toISOString();
  await db
    .update(plans)
    .set({ includedUsdMicros, updatedAt: now })
    .where(eq(plans.id, starter.id));

  const sync = await syncPlanToOpenMeter(starter.id);
  if (!sync.ok) {
    return NextResponse.json(
      {
        success: true,
        id: starter.id,
        includedUsdMicros,
        syncError: sync.error,
      },
      { status: 200 },
    );
  }

  const refreshed = await db.select().from(plans).where(eq(plans.id, starter.id)).limit(1);
  return NextResponse.json({
    success: true,
    id: starter.id,
    includedUsdMicros: refreshed[0]?.includedUsdMicros ?? includedUsdMicros,
    openmeterPlanId: sync.openmeterPlanId ?? refreshed[0]?.openmeterPlanId ?? null,
  });
}
