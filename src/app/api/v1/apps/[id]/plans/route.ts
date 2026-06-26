import { NextResponse } from "next/server";
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
import { billingPlansApiV2Enabled } from "@/lib/billing/feature-flags";
import { listBillingProducts } from "@/lib/billing/backend";
import { toPlanApiRow } from "@/lib/billing/product-dto";
import { fetchPipelineCatalog } from "@/lib/naap-catalog";
import {
  archivePlanInOpenMeter,
  syncPlanToOpenMeter,
} from "@/lib/openmeter/plans-sync";
import {
  assertCapabilityRowsDiscoverable,
  loadDiscoverableSetForApp,
  NETWORK_DEFAULT_PLAN_DISPLAY_NAME,
  NETWORK_DEFAULT_PLAN_INTERNAL_NAME,
} from "@/lib/network-default-plan";
import {
  STARTER_DEFAULT_PLAN_DISPLAY_NAME,
  STARTER_DEFAULT_PLAN_INTERNAL_NAME,
} from "@/lib/starter-default-plan-display";
import { parseRetailRateUsd, defaultRetailRateUsd } from "@/lib/plan-pricing";
import {
  resolveCapabilityFeatureKey,
  validateCapabilityFeatureKeys,
} from "@/lib/openmeter/capability-features";
import { validateCustomPlanName } from "@/lib/openmeter/plan-naming";

async function requireOwnedDiscoveryProfile(
  appId: string,
  discoveryProfileId: string | null,
  executor: Pick<typeof db, "select"> = db,
): Promise<{ ok: true } | { ok: false; error: string }> {
  if (discoveryProfileId === null) {
    return { ok: true };
  }
  const row = await executor
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

function coerceJsonScalarString(raw: unknown, fallback = ""): string {
  if (raw === undefined || raw === null) {
    return fallback;
  }
  if (typeof raw === "string") {
    return raw;
  }
  if (
    typeof raw === "number" ||
    typeof raw === "boolean" ||
    typeof raw === "bigint"
  ) {
    return String(raw);
  }
  return fallback;
}

function parseOptionalNonNegativeIntString(
  raw: unknown,
  fieldName: string,
): { ok: true; value: string | null } | { ok: false; error: string } {
  if (raw === undefined || raw === null) {
    return { ok: true, value: null };
  }
  const s = coerceJsonScalarString(raw).trim();
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

function parseOptionalRetailRateUsd(
  raw: unknown,
  fieldName: string,
): { ok: true; value: string | null } | { ok: false; error: string } {
  if (raw === undefined || raw === null) {
    return { ok: true, value: null };
  }
  const s = coerceJsonScalarString(raw).trim();
  if (!s) {
    return { ok: true, value: null };
  }
  const parsed = parseRetailRateUsd(s);
  if (!parsed) {
    return { ok: false, error: `${fieldName} must be a non-negative decimal USD amount` };
  }
  return { ok: true, value: parsed };
}

function resolveOverageRateUsdForPost(
  planType: string,
  body: Record<string, unknown>,
): { ok: true; value: string | null } | { ok: false; error: string } {
  if (planType === "free") {
    return { ok: true, value: null };
  }
  const parsed = parseOptionalRetailRateUsd(body.overageRateUsd, "overageRateUsd");
  if (!parsed.ok) {
    return parsed;
  }
  return { ok: true, value: parsed.value ?? defaultRetailRateUsd() };
}

function resolveOverageRateUsdForPut(
  planType: string,
  body: Record<string, unknown>,
  existing: string | null,
): { ok: true; value: string | null } | { ok: false; error: string } {
  if (planType === "free") {
    return { ok: true, value: null };
  }
  if (body.overageRateUsd === undefined) {
    return { ok: true, value: existing ?? defaultRetailRateUsd() };
  }
  return parseOptionalRetailRateUsd(body.overageRateUsd, "overageRateUsd");
}

function parseCapabilities(input: unknown): {
  capabilities: Array<{
    pipeline: string;
    modelId: string;
    maxPricePerUnit: string | null;
    retailRateUsd: string | null;
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

    const rawRetail = value.retailRateUsd;
    let parsedRetailUsd: string | null = null;
    if (rawRetail !== null && rawRetail !== undefined) {
      const s = coerceJsonScalarString(rawRetail).trim();
      if (s) {
        parsedRetailUsd = parseRetailRateUsd(s);
        if (!parsedRetailUsd) {
          throw new Error(`capabilities[${index}].retailRateUsd must be a non-negative decimal USD amount`);
        }
      }
    }

    return {
      pipeline,
      modelId,
      maxPricePerUnit:
        value.maxPricePerUnit === null || value.maxPricePerUnit === undefined
          ? null
          : coerceJsonScalarString(value.maxPricePerUnit),
      retailRateUsd: parsedRetailUsd,
    };
  });

  return { capabilities };
}

async function resolveAppForPlansRead(clientId: string, request: Request) {
  const clientAuth = await authenticateAppClient(request);
  if (clientAuth?.appId === clientId) {
    const app = await getProviderApp(clientId);
    return app;
  }
  const auth = await getAuthorizedProviderApp(clientId, request);
  return auth?.app ?? null;
}

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id: clientId } = await params;
  const app = await resolveAppForPlansRead(clientId, request);
  if (!app) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  const appId = app.id;

  const url = new URL(request.url);
  const includeInternals =
    url.searchParams.get("includeInternals") === "1" ||
    url.searchParams.get("includeInternals") === "true";
  const apiVersion = url.searchParams.get("apiVersion") || "1";

  if (billingPlansApiV2Enabled() && (apiVersion === "2" || url.searchParams.get("format") === "billing")) {
    const products = await listBillingProducts(appId);
    return NextResponse.json({
      apiVersion: 2,
      products,
      plans: products,
    });
  }

  const resolved = await resolvePlansDiscoveryForApp(appId);

  return NextResponse.json({
    apiVersion: 1,
    plans: resolved.map((r) =>
      toPlanApiRow({
        clientId,
        resolved: {
          ...r,
          discoveryProfileId: r.discoveryProfileId ?? r.plan.discoveryProfileId,
        },
        includeInternals,
      }),
    ),
  });
}

export async function POST(
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

  const appId = auth.app.id;

  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON" }, { status: 400 });
  }
  const nameCheck = validateCustomPlanName(coerceJsonScalarString(body.name));
  if (!nameCheck.ok) {
    return NextResponse.json({ error: nameCheck.error }, { status: 400 });
  }
  const name = nameCheck.value;
  if (name === NETWORK_DEFAULT_PLAN_INTERNAL_NAME || name === NETWORK_DEFAULT_PLAN_DISPLAY_NAME) {
    return NextResponse.json(
      { error: "This plan name is reserved for the Network Price default plan" },
      { status: 400 },
    );
  }
  if (name === STARTER_DEFAULT_PLAN_INTERNAL_NAME || name === STARTER_DEFAULT_PLAN_DISPLAY_NAME) {
    return NextResponse.json(
      { error: "This plan name is reserved for the Starter default plan" },
      { status: 400 },
    );
  }
  if ("is_network_default" in body || "is_starter_default" in body) {
    return NextResponse.json(
      { error: "is_network_default and is_starter_default cannot be set on created plans" },
      { status: 400 },
    );
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

  if (parsedCapabilities.capabilities.length > 0) {
    let catalogLite;
    try {
      const cat = await fetchPipelineCatalog();
      catalogLite = cat.map((e) => ({ id: e.id, models: e.models }));
    } catch {
      return NextResponse.json(
        { error: "Pipeline catalog unavailable; cannot validate capabilities" },
        { status: 503 },
      );
    }
    const discoverable = await loadDiscoverableSetForApp(appId, catalogLite, db);
    const discCheck = assertCapabilityRowsDiscoverable(
      catalogLite,
      discoverable,
      parsedCapabilities.capabilities,
    );
    if (!discCheck.ok) {
      return NextResponse.json(
        {
          error:
            "One or more capabilities are not discoverable under Network Price exclusions. Un-exclude them there first.",
          conflicts: discCheck.conflicts,
        },
        { status: 400 },
      );
    }
  }

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

  const planType = coerceJsonScalarString(body.type, "free");
  const overageRate = resolveOverageRateUsdForPost(planType, body);
  if (!overageRate.ok) {
    return NextResponse.json({ error: overageRate.error }, { status: 400 });
  }

  const rawIncludedUsd = body.includedUsdMicros;
  let includedUsdMicros: string | null = null;
  if (rawIncludedUsd !== undefined && rawIncludedUsd !== null) {
    const s = coerceJsonScalarString(rawIncludedUsd).trim();
    if (s !== "" && !isNonNegativeIntegerString(s)) {
      return NextResponse.json({ error: "includedUsdMicros must be a non-negative integer string" }, { status: 400 });
    }
    includedUsdMicros = s || null;
  }

  const planId = uuidv4();
  if (planType !== "free" && parsedCapabilities.capabilities.length > 0) {
    const featureKeys = validateCapabilityFeatureKeys({
      clientId: appId,
      planId,
      capabilities: parsedCapabilities.capabilities,
    });
    if (!featureKeys.ok) {
      return NextResponse.json({ error: featureKeys.error }, { status: 400 });
    }
  }
  const now = new Date().toISOString();
  try {
    await db.transaction(async (tx) => {
      const profCheck = await requireOwnedDiscoveryProfile(appId, discoveryProfileId, tx);
      if (!profCheck.ok) {
        throw Object.assign(new Error(profCheck.error), { code: "DISCOVERY_PROFILE" as const });
      }
      await tx.insert(plans).values({
        id: planId,
        clientId: appId,
        name,
        type: planType,
        priceAmount: coerceJsonScalarString(body.priceAmount, "0"),
        priceCurrency: coerceJsonScalarString(body.priceCurrency, "USD"),
        status: coerceJsonScalarString(body.status, "active"),
        overageRateUsd: overageRate.value,
        includedUsdMicros,
        billingCycle: typeof body.billingCycle === "string" ? body.billingCycle : "monthly",
        discoveryProfileId,
        isNetworkDefault: false,
        isStarterDefault: false,
        discoveryExcludedCapabilities: null,
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
          slaTargetP95Ms: null,
          maxPricePerUnit: capability.maxPricePerUnit,
          retailRateUsd: capability.retailRateUsd,
          openmeterFeatureKey: resolveCapabilityFeatureKey({
            clientId: appId,
            planId,
            pipeline: capability.pipeline,
            modelId: capability.modelId,
          }),
          createdAt: now,
        });
      }
    });
  } catch (e: unknown) {
    if (
      e &&
      typeof e === "object" &&
      "code" in e &&
      (e as { code?: string }).code === "DISCOVERY_PROFILE" &&
      e instanceof Error
    ) {
      return NextResponse.json({ error: e.message }, { status: 400 });
    }
    throw e;
  }

  const planStatus = coerceJsonScalarString(body.status, "active");
  if (planStatus === "active") {
    const sync = await syncPlanToOpenMeter(planId);
    if (!sync.ok) {
      return NextResponse.json({ id: planId, syncError: sync.error }, { status: 201 });
    }
  }

  return NextResponse.json({ id: planId }, { status: 201 });
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
  if (!body || typeof body.id !== "string" || !body.id.trim()) {
    return NextResponse.json({ error: "id is required and must be a string" }, { status: 400 });
  }
  const planId = String(body.id);
  const appId = auth.app.id;
  if (!planId) {
    return NextResponse.json({ error: "id is required" }, { status: 400 });
  }

  if ("is_network_default" in body) {
    return NextResponse.json(
      { error: "is_network_default cannot be changed via this API" },
      { status: 400 },
    );
  }

  let putPlanName: string | undefined;
  if (body.name !== undefined) {
    const nameCheck = validateCustomPlanName(coerceJsonScalarString(body.name));
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
    putPlanName = nameCheck.value;
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

  if (parsedCapabilities && parsedCapabilities.capabilities.length > 0) {
    let catalogLite;
    try {
      const cat = await fetchPipelineCatalog();
      catalogLite = cat.map((e) => ({ id: e.id, models: e.models }));
    } catch {
      return NextResponse.json(
        { error: "Pipeline catalog unavailable; cannot validate capabilities" },
        { status: 503 },
      );
    }
    const discoverable = await loadDiscoverableSetForApp(appId, catalogLite, db);
    const discCheck = assertCapabilityRowsDiscoverable(
      catalogLite,
      discoverable,
      parsedCapabilities.capabilities,
    );
    if (!discCheck.ok) {
      return NextResponse.json(
        {
          error:
            "One or more capabilities are not discoverable under Network Price exclusions. Un-exclude them there first.",
          conflicts: discCheck.conflicts,
        },
        { status: 400 },
      );
    }

    const featureKeys = validateCapabilityFeatureKeys({
      clientId: appId,
      planId,
      capabilities: parsedCapabilities.capabilities,
    });
    if (!featureKeys.ok) {
      return NextResponse.json({ error: featureKeys.error }, { status: 400 });
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

    if (existing.isNetworkDefault) {
      return { tag: "network_default" as const };
    }
    if (existing.isStarterDefault) {
      return { tag: "starter_default" as const };
    }

    if (discoveryProfileIdPut !== undefined && discoveryProfileIdPut !== null) {
      const profCheck = await requireOwnedDiscoveryProfile(appId, discoveryProfileIdPut, tx);
      if (!profCheck.ok) {
        return { tag: "validation" as const, error: profCheck.error };
      }
    }

    const nextType =
      body.type === undefined ? existing.type : coerceJsonScalarString(body.type);
    const overageRate = resolveOverageRateUsdForPut(nextType, body, existing.overageRateUsd);
    if (!overageRate.ok) {
      return { tag: "validation" as const, error: overageRate.error };
    }

    const rawIncludedUsdPut = body.includedUsdMicros;
    let includedUsdMicrosPut: string | null | undefined = undefined; // undefined = don't change
    if (rawIncludedUsdPut !== undefined) {
      if (rawIncludedUsdPut === null) {
        includedUsdMicrosPut = null;
      } else {
        const s = coerceJsonScalarString(rawIncludedUsdPut).trim();
        if (s !== "" && !isNonNegativeIntegerString(s)) {
          return { tag: "validation" as const, error: "includedUsdMicros must be a non-negative integer string" };
        }
        includedUsdMicrosPut = s || null;
      }
    }

    const updated = await tx
      .update(plans)
      .set({
        name: putPlanName ?? existing.name,
        type: nextType,
        priceAmount:
          body.priceAmount === undefined
            ? existing.priceAmount
            : coerceJsonScalarString(body.priceAmount),
        priceCurrency:
          body.priceCurrency === undefined
            ? existing.priceCurrency
            : coerceJsonScalarString(body.priceCurrency),
        status:
          body.status === undefined ? existing.status : coerceJsonScalarString(body.status),
        overageRateUsd: overageRate.value,
        ...(includedUsdMicrosPut !== undefined ? { includedUsdMicros: includedUsdMicrosPut } : {}),
        ...(body.billingCycle === undefined
          ? {}
          : { billingCycle: coerceJsonScalarString(body.billingCycle) }),
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
          slaTargetP95Ms: null,
          maxPricePerUnit: capability.maxPricePerUnit,
          retailRateUsd: capability.retailRateUsd,
          openmeterFeatureKey: resolveCapabilityFeatureKey({
            clientId: appId,
            planId,
            pipeline: capability.pipeline,
            modelId: capability.modelId,
          }),
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
  if (txnResult.tag === "network_default") {
    return NextResponse.json(
      {
        error:
          "The Network Price default plan cannot be edited via this endpoint; update exclusions via PUT /manifest",
      },
      { status: 400 },
    );
  }
  if (txnResult.tag === "starter_default") {
    return NextResponse.json(
      {
        error:
          "The Starter default plan cannot be edited via this endpoint; use PUT /starter-plan",
      },
      { status: 400 },
    );
  }

  const updatedStatus =
    body.status === undefined ? undefined : coerceJsonScalarString(body.status);
  const shouldSync =
    (updatedStatus ?? "active") === "active" &&
    txnResult.tag === "ok";
  if (shouldSync) {
    const sync = await syncPlanToOpenMeter(planId);
    if (!sync.ok) {
      return NextResponse.json({ success: true, id: planId, syncError: sync.error });
    }
  }

  return NextResponse.json({ success: true, id: planId });
}

export async function DELETE(
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

  const { searchParams } = new URL(request.url);
  const planId = searchParams.get("planId");
  const appId = auth.app.id;
  if (!planId) {
    return NextResponse.json({ error: "planId is required" }, { status: 400 });
  }

  const deleted = await db.transaction(async (tx) => {
    const planRows = await tx
      .select({
        id: plans.id,
        isNetworkDefault: plans.isNetworkDefault,
        isStarterDefault: plans.isStarterDefault,
      })
      .from(plans)
      .where(and(eq(plans.id, planId), eq(plans.clientId, appId)))
      .limit(1);

    if (!planRows[0]) {
      return false;
    }
    if (planRows[0].isNetworkDefault) {
      return "network_default" as const;
    }
    if (planRows[0].isStarterDefault) {
      return "starter_default" as const;
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
  if (deleted === "network_default") {
    return NextResponse.json(
      { error: "The Network Price default plan cannot be deleted" },
      { status: 409 },
    );
  }
  if (deleted === "starter_default") {
    return NextResponse.json(
      { error: "The Starter default plan cannot be deleted" },
      { status: 409 },
    );
  }

  try {
    await archivePlanInOpenMeter(planId);
  } catch {
    /* best effort */
  }

  return NextResponse.json({ success: true });
}
