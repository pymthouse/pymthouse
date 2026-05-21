import { NextRequest, NextResponse } from "next/server";
import {
  appEditForbiddenResponse,
  canEditProviderApp,
  getAuthorizedProviderApp,
} from "@/domains/developer-apps/runtime/provider-access";
import {
  createPlan,
  deletePlan,
  getPlanForApp,
  updatePlan,
  PlanValidationError,
} from "@/domains/plans-discovery/repo/plans";
import { parseCreatePlanInput, parseUpdatePlanInput } from "@/domains/plans-discovery/service/plan-input";
import { readResolvedPlans, resolveReadablePlansApp } from "@/domains/plans-discovery/runtime/plans-read";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id: clientId } = await params;
  const app = await resolveReadablePlansApp(clientId, request);
  if (!app) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  return NextResponse.json({ plans: await readResolvedPlans(clientId, app.id) });
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
  const parsed = parseCreatePlanInput(body);
  if (!parsed.ok) {
    return NextResponse.json({ error: parsed.error }, { status: 400 });
  }

  try {
    const planId = await createPlan(auth.app.id, parsed.value);
    return NextResponse.json({ id: planId }, { status: 201 });
  } catch (error) {
    if (error instanceof PlanValidationError) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    throw error;
  }
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
  const appId = auth.app.id;
  const existing = await getPlanForApp(appId, String(body.id ?? ""));
  if (!existing) {
    if (!body || typeof body.id !== "string" || !body.id.trim()) {
      return NextResponse.json({ error: "id is required and must be a string" }, { status: 400 });
    }
    return NextResponse.json({ error: "Plan not found" }, { status: 404 });
  }

  const parsed = parseUpdatePlanInput(body, {
    type: existing.type,
    includedUnits: existing.includedUnits != null ? String(existing.includedUnits) : null,
    overageRateWei: existing.overageRateWei != null ? String(existing.overageRateWei) : null,
  });
  if (!parsed.ok) {
    return NextResponse.json({ error: parsed.error }, { status: 400 });
  }

  const result = await updatePlan(appId, parsed.value);
  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: result.status });
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

  const deleted = await deletePlan(appId, planId);
  if (!deleted.ok) {
    return NextResponse.json({ error: deleted.error }, { status: 404 });
  }

  return NextResponse.json({ success: true });
}
