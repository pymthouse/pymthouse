import { NextRequest, NextResponse } from "next/server";
import {
  canManageMerchantBilling,
  getAuthorizedProviderApp,
  merchantBillingForbiddenResponse,
} from "@/lib/provider-apps";
import {
  deleteCustomerPlanOverride,
  getCustomerPlanOverride,
  listCustomerPlanOverrides,
  upsertCustomerPlanOverride,
} from "@/lib/openmeter/customer-plan-overrides";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id: clientId } = await params;
  const auth = await getAuthorizedProviderApp(clientId, request);
  if (!auth) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const externalUserId = new URL(request.url).searchParams.get("externalUserId")?.trim();
  if (externalUserId) {
    const override = await getCustomerPlanOverride({
      clientId: auth.app.id,
      externalUserId,
    });
    return NextResponse.json({ override });
  }

  const items = await listCustomerPlanOverrides(auth.app.id);
  return NextResponse.json({ items });
}

export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id: clientId } = await params;
  const auth = await getAuthorizedProviderApp(clientId, request);
  if (!auth) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  if (!(await canManageMerchantBilling(auth))) {
    return merchantBillingForbiddenResponse();
  }

  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const externalUserId =
    typeof body.externalUserId === "string" ? body.externalUserId.trim() : "";
  const planId = typeof body.planId === "string" ? body.planId.trim() : "";
  if (!externalUserId || !planId) {
    return NextResponse.json(
      { error: "externalUserId and planId are required" },
      { status: 400 },
    );
  }

  try {
    const override = await upsertCustomerPlanOverride({
      clientId: auth.app.id,
      externalUserId,
      planId,
      notes: typeof body.notes === "string" ? body.notes : null,
    });
    return NextResponse.json({ override });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: message }, { status: 400 });
  }
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id: clientId } = await params;
  const auth = await getAuthorizedProviderApp(clientId, request);
  if (!auth) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  if (!(await canManageMerchantBilling(auth))) {
    return merchantBillingForbiddenResponse();
  }

  const externalUserId =
    new URL(request.url).searchParams.get("externalUserId")?.trim() || "";
  if (!externalUserId) {
    return NextResponse.json({ error: "externalUserId is required" }, { status: 400 });
  }

  const ok = await deleteCustomerPlanOverride({
    clientId: auth.app.id,
    externalUserId,
  });
  if (!ok) {
    return NextResponse.json({ error: "Override not found" }, { status: 404 });
  }
  return NextResponse.json({ success: true });
}
