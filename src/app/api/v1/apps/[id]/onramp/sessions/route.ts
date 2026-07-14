import { NextRequest, NextResponse } from "next/server";
import { getAuthorizedProviderApp } from "@/lib/provider-apps";
import { createOnRampSession } from "@/lib/onramp/sessions";

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id: clientId } = await params;
  const access = await getAuthorizedProviderApp(clientId, request);
  if (!access) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const body = await request.json().catch(() => ({}));
  const externalUserId = String(body.externalUserId || "").trim();
  const depositWalletAddress = String(body.depositWalletAddress || "").trim();
  const onRampTransactionId = String(body.onRampTransactionId || "").trim();
  const fiatCurrencyCode =
    typeof body.fiatCurrencyCode === "string" ? body.fiatCurrencyCode.trim() : undefined;
  const fiatAmount =
    typeof body.fiatAmount === "string" ? body.fiatAmount.trim() : undefined;
  const onrampProvider =
    typeof body.onrampProvider === "string" ? body.onrampProvider.trim() : undefined;
  const turnkeyOrganizationId =
    typeof body.turnkeyOrganizationId === "string"
      ? body.turnkeyOrganizationId.trim()
      : undefined;

  if (!externalUserId || !depositWalletAddress || !onRampTransactionId) {
    return NextResponse.json(
      {
        error:
          "externalUserId, depositWalletAddress, and onRampTransactionId are required",
      },
      { status: 400 },
    );
  }

  try {
    const session = await createOnRampSession({
      clientId: access.app.id,
      externalUserId,
      depositWalletAddress,
      onRampTransactionId,
      turnkeyOrganizationId,
      onrampProvider,
      fiatCurrencyCode,
      fiatAmount,
    });

    return NextResponse.json({
      sessionId: session.id,
      status: session.status,
      onRampTransactionId: session.onRampTransactionId,
      externalUserId,
      depositWalletAddress,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to create on-ramp session";
    console.error("[onramp/sessions] create failed:", error);
    if (
      message.includes("required") ||
      message.includes("must be a valid EVM address") ||
      message.includes("belongs to another app")
    ) {
      return NextResponse.json({ error: message }, { status: 400 });
    }
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
