import { NextRequest, NextResponse } from "next/server";
import { authenticateAppClient } from "@/lib/auth";
import { getAuthorizedProviderApp, getProviderApp } from "@/lib/provider-apps";
import { getUsageBalanceAllowance } from "@/lib/openmeter/spendable-allowance";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id: clientId } = await params;
  const externalUserId = request.nextUrl.searchParams.get("externalUserId")?.trim();
  if (!externalUserId) {
    return NextResponse.json({ error: "externalUserId is required" }, { status: 400 });
  }

  const clientAuth = await authenticateAppClient(request);
  let app = clientAuth?.appId === clientId ? await getProviderApp(clientId) : null;
  if (!app) {
    try {
      const providerAuth = await getAuthorizedProviderApp(clientId);
      app = providerAuth?.app ?? null;
    } catch {
      app = null;
    }
  }
  if (!app) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const balance = await getUsageBalanceAllowance({
    clientId: app.id,
    externalUserId,
  });
  if (!balance) {
    return NextResponse.json({ error: "OpenMeter not configured" }, { status: 503 });
  }

  return NextResponse.json({
    externalUserId,
    ...balance,
  });
}
