import { NextRequest, NextResponse } from "next/server";
import { authenticateAppClient } from "@/lib/auth";
import { getAuthorizedProviderApp, getProviderApp } from "@/lib/provider-apps";
import { createEndUserCheckout } from "@/lib/openmeter/subscriptions-billing";

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id: clientId } = await params;
  const clientAuth = await authenticateAppClient(request);
  let app = clientAuth?.appId === clientId ? await getProviderApp(clientId) : null;
  if (!app) {
    try {
      const providerAuth = await getAuthorizedProviderApp(clientId, request);
      app = providerAuth?.app ?? null;
    } catch {
      app = null;
    }
  }
  if (!app) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const planId = typeof body.planId === "string" ? body.planId.trim() : "";
  const externalUserId =
    typeof body.externalUserId === "string" ? body.externalUserId.trim() : "";
  if (!planId || !externalUserId) {
    return NextResponse.json(
      { error: "planId and externalUserId are required" },
      { status: 400 },
    );
  }

  try {
    const result = await createEndUserCheckout({
      clientId: app.id,
      externalUserId,
      planId,
      successUrl: typeof body.successUrl === "string" ? body.successUrl : undefined,
      cancelUrl: typeof body.cancelUrl === "string" ? body.cancelUrl : undefined,
    });
    return NextResponse.json(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
