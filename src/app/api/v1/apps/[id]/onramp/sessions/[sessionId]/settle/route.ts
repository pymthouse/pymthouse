import { NextRequest, NextResponse } from "next/server";
import {
  canManageMerchantBilling,
  getAuthorizedProviderApp,
} from "@/lib/provider-apps";
import { settleOnRampSession } from "@/lib/onramp/sessions";

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; sessionId: string }> },
) {
  const { id: clientId, sessionId } = await params;
  const access = await getAuthorizedProviderApp(clientId, request);
  if (!access) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  if (!(await canManageMerchantBilling(access))) {
    return NextResponse.json(
      { error: "Only the app owner or platform admin can settle prepaid credits." },
      { status: 403 },
    );
  }

  try {
    const result = await settleOnRampSession({
      clientId: access.app.id,
      sessionId,
    });

    return NextResponse.json({
      sessionId: result.sessionId,
      status: result.status,
      externalUserId: result.externalUserId,
      grantedUsdMicros: result.grantedUsdMicros,
      balanceUsdMicros: result.balanceUsdMicros,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Settlement failed";
    console.error("[onramp/sessions/settle] failed:", error);

    if (message.includes("not found")) {
      return NextResponse.json({ error: message }, { status: 404 });
    }
    if (message.includes("not completed") || message.includes("transaction pending")) {
      return NextResponse.json({ error: message }, { status: 409 });
    }
    if (
      message.includes("cancelled") ||
      message.includes("failed") ||
      message.includes("transaction cancelled") ||
      message.includes("transaction failed")
    ) {
      return NextResponse.json({ error: message }, { status: 422 });
    }
    if (message.includes("Missing required env")) {
      return NextResponse.json({ error: message }, { status: 503 });
    }
    if (message.includes("OpenMeter not configured")) {
      return NextResponse.json({ error: message }, { status: 503 });
    }

    return NextResponse.json({ error: message }, { status: 502 });
  }
}
