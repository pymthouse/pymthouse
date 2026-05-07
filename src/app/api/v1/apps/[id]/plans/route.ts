import { NextRequest, NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { v4 as uuidv4 } from "uuid";
import { db } from "@/db/index";
import { discoveryProfiles, planCapabilityBundles, plans } from "@/db/schema";
import { authenticateAppClient } from "@/lib/auth";
import {
  canEditProviderApp,
  getAuthorizedProviderApp,
  getProviderApp,
  appEditForbiddenResponse,
} from "@/lib/provider-apps";
import { resolvePlansDiscoveryForApp } from "@/lib/discovery-profile-resolve";

async function requireOwnedDiscoveryProfile(
  appId: string,
  discoveryProfileId: string | null,
): Promise<{ ok: true } | { ok: false; error: string }> {
  if (discoveryProfileId === null) {
    return { ok: true };
  }
  const row = await db
    .select({ id: discoveryProfiles.id })
    .from(discoveryProfiles)
    .where(
      and(eq(discoveryProfiles.id, discoveryProfileId), eq(discoveryProfiles.clientId, appId)),
    )
    .limit(1);
  if (!row[0]) {
    return { ok: false, error: "discoveryProfileId not found for this app" };
  }
  return { ok: true };
}

function isNonNegativeIntegerString(s: string): boolean {
  return /^\d+$/.test(s);
}

function parseOptionalNonNegativeBps(
  raw: unknown,
  fieldName: string,
): { ok: true; value: number | null } | { ok: false; error: string } {
  if (raw === undefined || raw === null) return { ok: true, value: null };
  const n = typeof raw === "number" ? raw : Number(String(raw).trim());
  if (!Number.isInteger(n) || n < 0) {
    return { ok: false, error: `${fieldName} must be a non-negative integer (basis points)` };
  }
  return { ok: true, value: n };
}

/** Present empty → null; present non-empty must match non-negative integer digits. */
function parseOptionalNonNegativeIntString(
  raw: unknown,
  fieldName: string,
): { ok: true; value: string | null } | { ok: false; error: string } {
  if (raw === undefined || raw === null) {
    return { ok: true, value: null };
  }
  const s = String(raw).trim();
  if (s === "") {
    return { ok: true, value: null };
  }
  if (!isNonNegativeIntegerString(s)) {
    return {
      ok: false,
      error: `${fieldName} must be a non-negative integer string`,
    };
  }
  return { ok: true, value: s };
}

function resolveBillingFieldsForPost(
  planType: string,
  body: Record<string, unknown>,
):
  | { ok: true; includedUnits: string | null; overageRateWei: string | null }
  | { ok: false; error: string } {
  if (planType === "free") {
    return { ok: true, includedUnits: null, overageRateWei: null };
  }
  if (planType === "subscription") {
    const inc = parseOptionalNonNegativeIntString(body.includedUnits, "includedUnits");
    const ovr = parseOptionalNonNegativeIntString(body.overageRateWei, "overageRateWei");
    if (!inc.ok) return inc;
    if (!ovr.ok) return ovr;
    if (inc.value === null || ovr.value === null) {
      return {
        ok: false,
        error: "includedUnits and overageRateWei are required for subscription plans",
      };
    }
    return { ok: true, includedUnits: inc.value, overageRateWei: ovr.value };
  }
  if (planType === "usage") {
    const inc = parseOptionalNonNegativeIntString(body.includedUnits, "includedUnits");
    const ovr = parseOptionalNonNegativeIntString(body.overageRateWei, "overageRateWei");
    if (!inc.ok) return inc;
    if (!ovr.ok) return ovr;
    return { ok: true, includedUnits: inc.value, overageRateWei: ovr.value };
  }
  return { ok: true, includedUnits: null, overageRateWei: null };
}

function mergeBillingFieldForPut(
  rawBody: unknown,
  existing: string | null,
  fieldName: string,
): { ok: true; value: string | null } | { ok: false; error: string } {
  if (rawBody === undefined) {
    if (existing === null || existing === undefined) {
      return { ok: true, value: null };
    }
    const t = String(existing).trim();
    if (t === "") {
      return { ok: true, value: null };
    }
    if (!isNonNegativeIntegerString(t)) {
      return {
        ok: false,
        error: `${fieldName} must be a non-negative integer string`,
      };
    }
    return { ok: true, value: t };
  }
  return parseOptionalNonNegativeIntString(rawBody, fieldName);
}

function resolveBillingFieldsForPut(
  effectiveType: string,
  body: Record<string, unknown>,
  existing: { includedUnits: string | null; overageRateWei: string | null },
):
  | { ok: true; includedUnits: string | null; overageRateWei: string | null }
  | { ok: false; error: string } {
  if (effectiveType === "free") {
    return { ok: true, includedUnits: null, overageRateWei: null };
  }
  if (effectiveType === "subscription") {
    const inc = mergeBillingFieldForPut(body.includedUnits, existing.includedUnits, "includedUnits");
    const ovr = mergeBillingFieldForPut(body.overageRateWei, existing.overageRateWei, "overageRateWei");
    if (!inc.ok) return inc;
    if (!ovr.ok) return ovr;
    if (inc.value === null || ovr.value === null) {
      return {
        ok: false,
        error: "includedUnits and overageRateWei are required for subscription plans",
      };
    }
    return { ok: true, includedUnits: inc.value, overageRateWei: ovr.value };
  }
  if (effectiveType === "usage") {
    const inc = mergeBillingFieldForPut(body.includedUnits, existing.includedUnits, "includedUnits");
    const ovr = mergeBillingFieldForPut(body.overageRateWei, existing.overageRateWei, "overageRateWei");
    if (!inc.ok) return inc;
    if (!ovr.ok) return ovr;
    return { ok: true, includedUnits: inc.value, overageRateWei: ovr.value };
  }
  return { ok: true, includedUnits: null, overageRateWei: null };
}

function parseCapabilities(input: unknown): {
  capabilities: Array<{
    pipeline: string;
    modelId: string;
    slaTargetScore: number | null;
    slaTargetP95Ms: number | null;
    maxPricePerUnit: string | null;
    upchargePercentBps: number | null;
  }>;
  error?: string;
} {
  if (input === undefined) {
    return { capabilities: [] };
  }

  if (!Array.isArray(input)) {
    return { capabilities: [], error: "capabilities must be an array" };
  }

  const capabilities = input.map((raw, index) => {
    const value = (raw ?? {}) as Record<string, unknown>;
    const pipeline = typeof value.pipeline === "string" ? value.pipeline.trim() : "";
    const modelId = typeof value.modelId === "string" ? value.modelId.trim() : "";

    if (!pipeline) {
      throw new Error(`capabilities[${index}].pipeline is required`);
    }

    if (!modelId) {
      throw new Error(`capabilities[${index}].modelId is required`);
    }

    const rawSlaTargetScore = value.slaTargetScore;
    const rawSlaTargetP95Ms = value.slaTargetP95Ms;
    const parsedSlaTargetScore =
      rawSlaTargetScore === null || rawSlaTargetScore === undefined
        ? null
        : Number(rawSlaTargetScore);
    const parsedSlaTargetP95Ms =
      rawSlaTargetP95Ms === null || rawSlaTargetP95Ms === undefined
        ? null
        : Number(rawSlaTargetP95Ms);

    if (parsedSlaTargetScore !== null && !Number.isFinite(parsedSlaTargetScore)) {
      throw new Error(`capabilities[${index}].slaTargetScore must be numeric`);
    }

    if (parsedSlaTargetP95Ms !== null && !Number.isFinite(parsedSlaTargetP95Ms)) {
      throw new Error(`capabilities[${index}].slaTargetP95Ms must be numeric`);
    }

    const rawUpcharge = value.upchargePercentBps;
    const parsedUpchargeBps =
      rawUpcharge === null || rawUpcharge === undefined
        ? null
        : parseInt(String(rawUpcharge), 10);
    if (parsedUpchargeBps !== null && (!Number.isInteger(parsedUpchargeBps) || parsedUpchargeBps < 0)) {
      throw new Error(`capabilities[${index}].upchargePercentBps must be a non-negative integer`);
    }

    return {
      pipeline,
      modelId,
      slaTargetScore: parsedSlaTargetScore,
      slaTargetP95Ms: parsedSlaTargetP95Ms,
      maxPricePerUnit:
        value.maxPricePerUnit === null || value.maxPricePerUnit === undefined
          ? null
          : String(value.maxPricePerUnit),
      upchargePercentBps: parsedUpchargeBps,
    };
  });

  return { capabilities };
}

async function resolveAppForPlansRead(clientId: string, request: NextRequest) {
  const clientAuth = await authenticateAppClient(request);
  if (clientAuth?.appId === clientId) {
    const app = await getProviderApp(clientId);
    return app;
  }
  const auth = await getAuthorizedProviderApp(clientId);
  return auth?.app ?? null;
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id: clientId } = await params;
  const app = await resolveAppForPlansRead(clientId, request);
  if (!app) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  const appId = app.id;

  const resolved = await resolvePlansDiscoveryForApp(appId);

  return NextResponse.json({
    plans: resolved.map((r) => {
      const plan = r.plan;
      return {
        ...plan,
        discoveryProfileId: plan.discoveryProfileId ?? null,
        discoveryPolicy: r.discoveryPolicy,
        includedUnits:
          plan.includedUnits !== null && plan.includedUnits !== undefined
            ? plan.includedUnits.toString()
            : null,
        overageRateWei:
          plan.overageRateWei !== null && plan.overageRateWei !== undefined
            ? plan.overageRateWei.toString()
            : null,
        clientId,
        capabilities: r.capabilities.map((c) => ({
          ...c,
          clientId,
        })),
      };
    }),
  });
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id: clientId } = await params;
  const auth = await getAuthorizedProviderApp(clientId);
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
  const name = String(body.name || "").trim();
  if (!name) {
    return NextResponse.json({ error: "name is required" }, { status: 400 });
  }

  let parsedCapabilities: ReturnType<typeof parseCapabilities>;
  try {
    parsedCapabilities = parseCapabilities(body.capabilities);
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Invalid capabilities" },
      { status: 400 },
    );
  }

  if (parsedCapabilities.error) {
    return NextResponse.json({ error: parsedCapabilities.error }, { status: 400 });
  }

  const appId = auth.app.id;

  let discoveryProfileId: string | null = null;
  if (body.discoveryProfileId !== undefined) {
    if (body.discoveryProfileId === null || body.discoveryProfileId === "") {
      discoveryProfileId = null;
    } else if (typeof body.discoveryProfileId === "string" && body.discoveryProfileId.trim()) {
      discoveryProfileId = body.discoveryProfileId.trim();
    } else {
      return NextResponse.json(
        { error: "discoveryProfileId must be a non-empty string or null" },
        { status: 400 },
      );
    }
  }
  const profCheck = await requireOwnedDiscoveryProfile(appId, discoveryProfileId);
  if (!profCheck.ok) {
    return NextResponse.json({ error: profCheck.error }, { status: 400 });
  }

  const planType = String(body.type || "free");
  const billing = resolveBillingFieldsForPost(planType, body);
  if (!billing.ok) {
    return NextResponse.json({ error: billing.error }, { status: 400 });
  }

  // Parse new USD/upcharge fields
  const generalUpcharge = parseOptionalNonNegativeBps(body.generalUpchargePercentBps, "generalUpchargePercentBps");
  if (!generalUpcharge.ok) return NextResponse.json({ error: generalUpcharge.error }, { status: 400 });
  const payPerUseUpcharge = parseOptionalNonNegativeBps(body.payPerUseUpchargePercentBps, "payPerUseUpchargePercentBps");
  if (!payPerUseUpcharge.ok) return NextResponse.json({ error: payPerUseUpcharge.error }, { status: 400 });

  const rawIncludedUsd = body.includedUsdMicros;
  let includedUsdMicros: string | null = null;
  if (rawIncludedUsd !== undefined && rawIncludedUsd !== null) {
    const s = String(rawIncludedUsd).trim();
    if (s !== "" && !isNonNegativeIntegerString(s)) {
      return NextResponse.json({ error: "includedUsdMicros must be a non-negative integer string" }, { status: 400 });
    }
    includedUsdMicros = s || null;
  }

  const planId = uuidv4();
  const now = new Date().toISOString();
  await db.transaction(async (tx) => {
    await tx.insert(plans).values({
      id: planId,
      clientId: appId,
      name,
      type: planType,
      priceAmount: String(body.priceAmount || "0"),
      priceCurrency: String(body.priceCurrency || "USD"),
      status: String(body.status || "active"),
      includedUnits:
        billing.includedUnits !== null ? BigInt(billing.includedUnits) : null,
      overageRateWei:
        billing.overageRateWei !== null ? BigInt(billing.overageRateWei) : null,
      includedUsdMicros,
      generalUpchargePercentBps: generalUpcharge.value,
      payPerUseUpchargePercentBps: payPerUseUpcharge.value,
      billingCycle: typeof body.billingCycle === "string" ? body.billingCycle : "monthly",
      discoveryProfileId,
      createdAt: now,
      updatedAt: now,
    });

    for (const capability of parsedCapabilities.capabilities) {
      await tx.insert(planCapabilityBundles).values({
        id: uuidv4(),
        planId,
        clientId: appId,
        pipeline: capability.pipeline,
        modelId: capability.modelId,
        slaTargetScore: capability.slaTargetScore ?? null,
        slaTargetP95Ms: capability.slaTargetP95Ms ?? null,
        maxPricePerUnit: capability.maxPricePerUnit,
        upchargePercentBps: capability.upchargePercentBps,
        createdAt: now,
      });
    }
  });

  return NextResponse.json({ id: planId }, { status: 201 });
}

export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id: clientId } = await params;
  const auth = await getAuthorizedProviderApp(clientId);
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
  if (!body || typeof body.id !== "string" || !body.id.trim()) {
    return NextResponse.json({ error: "id is required and must be a string" }, { status: 400 });
  }
  const planId = String(body.id);
  const appId = auth.app.id;
  if (!planId) {
    return NextResponse.json({ error: "id is required" }, { status: 400 });
  }

  let discoveryProfileIdPut: string | null | undefined = undefined;
  if (body.discoveryProfileId !== undefined) {
    if (body.discoveryProfileId === null || body.discoveryProfileId === "") {
      discoveryProfileIdPut = null;
    } else if (typeof body.discoveryProfileId === "string" && body.discoveryProfileId.trim()) {
      discoveryProfileIdPut = body.discoveryProfileId.trim();
    } else {
      return NextResponse.json(
        { error: "discoveryProfileId must be a non-empty string or null" },
        { status: 400 },
      );
    }
  }
  if (discoveryProfileIdPut !== undefined && discoveryProfileIdPut !== null) {
    const profCheck = await requireOwnedDiscoveryProfile(appId, discoveryProfileIdPut);
    if (!profCheck.ok) {
      return NextResponse.json({ error: profCheck.error }, { status: 400 });
    }
  }

  let parsedCapabilities: ReturnType<typeof parseCapabilities> | null = null;
  if (body.capabilities !== undefined) {
    try {
      parsedCapabilities = parseCapabilities(body.capabilities);
    } catch (err) {
      return NextResponse.json(
        { error: err instanceof Error ? err.message : "Invalid capabilities" },
        { status: 400 },
      );
    }

    if (parsedCapabilities.error) {
      return NextResponse.json({ error: parsedCapabilities.error }, { status: 400 });
    }
  }

  const now = new Date().toISOString();
  const txnResult = await db.transaction(async (tx) => {
    const existingRows = await tx
      .select()
      .from(plans)
      .where(and(eq(plans.id, planId), eq(plans.clientId, appId)))
      .limit(1);
    const existing = existingRows[0];
    if (!existing) {
      return { tag: "notfound" as const };
    }

    const nextType = body.type !== undefined ? String(body.type) : existing.type;
    const billing = resolveBillingFieldsForPut(nextType, body, {
      includedUnits:
        existing.includedUnits != null ? String(existing.includedUnits) : null,
      overageRateWei:
        existing.overageRateWei != null ? String(existing.overageRateWei) : null,
    });
    if (!billing.ok) {
      return { tag: "validation" as const, error: billing.error };
    }

    // Parse new USD/upcharge fields for PUT
    const generalUpchargePut = parseOptionalNonNegativeBps(body.generalUpchargePercentBps, "generalUpchargePercentBps");
    if (!generalUpchargePut.ok) return { tag: "validation" as const, error: generalUpchargePut.error };
    const payPerUseUpchargePut = parseOptionalNonNegativeBps(body.payPerUseUpchargePercentBps, "payPerUseUpchargePercentBps");
    if (!payPerUseUpchargePut.ok) return { tag: "validation" as const, error: payPerUseUpchargePut.error };

    const rawIncludedUsdPut = body.includedUsdMicros;
    let includedUsdMicrosPut: string | null | undefined = undefined; // undefined = don't change
    if (rawIncludedUsdPut !== undefined) {
      if (rawIncludedUsdPut === null) {
        includedUsdMicrosPut = null;
      } else {
        const s = String(rawIncludedUsdPut).trim();
        if (s !== "" && !isNonNegativeIntegerString(s)) {
          return { tag: "validation" as const, error: "includedUsdMicros must be a non-negative integer string" };
        }
        includedUsdMicrosPut = s || null;
      }
    }

    const updated = await tx
      .update(plans)
      .set({
        name: body.name !== undefined ? String(body.name) : existing.name,
        type: nextType,
        priceAmount: body.priceAmount !== undefined ? String(body.priceAmount) : existing.priceAmount,
        priceCurrency: body.priceCurrency !== undefined ? String(body.priceCurrency) : existing.priceCurrency,
        status: body.status !== undefined ? String(body.status) : existing.status,
        includedUnits:
          billing.includedUnits !== null ? BigInt(billing.includedUnits) : null,
        overageRateWei:
          billing.overageRateWei !== null ? BigInt(billing.overageRateWei) : null,
        ...(generalUpchargePut.value !== null ? { generalUpchargePercentBps: generalUpchargePut.value } : {}),
        ...(payPerUseUpchargePut.value !== null ? { payPerUseUpchargePercentBps: payPerUseUpchargePut.value } : {}),
        ...(includedUsdMicrosPut !== undefined ? { includedUsdMicros: includedUsdMicrosPut } : {}),
        ...(body.billingCycle !== undefined ? { billingCycle: String(body.billingCycle) } : {}),
        ...(discoveryProfileIdPut !== undefined
          ? { discoveryProfileId: discoveryProfileIdPut }
          : {}),
        updatedAt: now,
      })
      .where(and(eq(plans.id, planId), eq(plans.clientId, appId)))
      .returning({ id: plans.id });

    if (updated.length === 0) {
      return { tag: "notfound" as const };
    }

    if (parsedCapabilities) {
      await tx
        .delete(planCapabilityBundles)
        .where(
          and(
            eq(planCapabilityBundles.planId, planId),
            eq(planCapabilityBundles.clientId, appId),
          ),
        );
      for (const capability of parsedCapabilities.capabilities) {
        await tx.insert(planCapabilityBundles).values({
          id: uuidv4(),
          planId,
          clientId: appId,
          pipeline: capability.pipeline,
          modelId: capability.modelId,
          slaTargetScore: capability.slaTargetScore ?? null,
          slaTargetP95Ms: capability.slaTargetP95Ms ?? null,
          maxPricePerUnit: capability.maxPricePerUnit,
          upchargePercentBps: capability.upchargePercentBps,
          createdAt: now,
        });
      }
    }

    return { tag: "ok" as const };
  });

  if (txnResult.tag === "notfound") {
    return NextResponse.json({ error: "Plan not found" }, { status: 404 });
  }
  if (txnResult.tag === "validation") {
    return NextResponse.json({ error: txnResult.error }, { status: 400 });
  }

  return NextResponse.json({ success: true });
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id: clientId } = await params;
  const auth = await getAuthorizedProviderApp(clientId);
  if (!auth) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  if (!(await canEditProviderApp(auth))) {
    return appEditForbiddenResponse();
  }

  const { searchParams } = new URL(request.url);
  const planId = searchParams.get("planId");
  const appId = auth.app.id;
  if (!planId) {
    return NextResponse.json({ error: "planId is required" }, { status: 400 });
  }

  const deleted = await db.transaction(async (tx) => {
    const planRows = await tx
      .select({ id: plans.id })
      .from(plans)
      .where(and(eq(plans.id, planId), eq(plans.clientId, appId)))
      .limit(1);

    if (!planRows[0]) {
      return false;
    }

    await tx
      .delete(planCapabilityBundles)
      .where(
        and(
          eq(planCapabilityBundles.planId, planId),
          eq(planCapabilityBundles.clientId, appId),
        ),
      );
    const removed = await tx
      .delete(plans)
      .where(and(eq(plans.id, planId), eq(plans.clientId, appId)))
      .returning({ id: plans.id });
    return removed.length > 0;
  });

  if (!deleted) {
    return NextResponse.json({ error: "Plan not found" }, { status: 404 });
  }

  return NextResponse.json({ success: true });
}
