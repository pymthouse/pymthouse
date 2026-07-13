import { NextRequest, NextResponse } from "next/server";
import {
  canManageMerchantBilling,
  getAuthorizedProviderApp,
  merchantBillingForbiddenResponse,
} from "@/lib/provider-apps";
import {
  createBillingAddon,
  deleteBillingAddon,
  listBillingAddons,
  purchaseBillingAddon,
} from "@/lib/openmeter/billing-addons";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id: clientId } = await params;
  const auth = await getAuthorizedProviderApp(clientId, request);
  if (!auth) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  const items = await listBillingAddons(auth.app.id);
  return NextResponse.json({ items });
}

export async function POST(
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

  const action = typeof body.action === "string" ? body.action.trim() : "create";

  try {
    if (action === "purchase") {
      const addonId = typeof body.addonId === "string" ? body.addonId.trim() : "";
      const externalUserId =
        typeof body.externalUserId === "string" ? body.externalUserId.trim() : "";
      if (!addonId || !externalUserId) {
        return NextResponse.json(
          { error: "addonId and externalUserId are required" },
          { status: 400 },
        );
      }
      const result = await purchaseBillingAddon({
        clientId: auth.app.id,
        addonId,
        externalUserId,
        successUrl: typeof body.successUrl === "string" ? body.successUrl : undefined,
        cancelUrl: typeof body.cancelUrl === "string" ? body.cancelUrl : undefined,
      });
      return NextResponse.json(result);
    }

    const name = typeof body.name === "string" ? body.name.trim() : "";
    const creditUsdMicros =
      typeof body.creditUsdMicros === "string"
        ? body.creditUsdMicros.trim()
        : body.creditUsdMicros != null
          ? String(body.creditUsdMicros)
          : "";
    if (!name || !creditUsdMicros) {
      return NextResponse.json(
        { error: "name and creditUsdMicros are required" },
        { status: 400 },
      );
    }
    const row = await createBillingAddon({
      clientId: auth.app.id,
      name,
      description: typeof body.description === "string" ? body.description : null,
      creditUsdMicros,
      priceAmount: typeof body.priceAmount === "string" ? body.priceAmount : "0",
      priceCurrency: typeof body.priceCurrency === "string" ? body.priceCurrency : "USD",
    });
    return NextResponse.json(row, { status: 201 });
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
  const addonId = new URL(request.url).searchParams.get("addonId")?.trim() || "";
  if (!addonId) {
    return NextResponse.json({ error: "addonId is required" }, { status: 400 });
  }
  const ok = await deleteBillingAddon({ clientId: auth.app.id, addonId });
  if (!ok) {
    return NextResponse.json({ error: "Add-on not found" }, { status: 404 });
  }
  return NextResponse.json({ success: true });
}
