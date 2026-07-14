import { NextRequest, NextResponse } from "next/server";
import {
  canManageMerchantBilling,
  getAuthorizedProviderApp,
} from "@/lib/provider-apps";
import { createOnRampSession } from "@/lib/onramp/sessions";
import { SANDBOX_ONRAMP_USD_AMOUNT } from "@/lib/onramp/amount";

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id: clientId } = await params;
  const access = await getAuthorizedProviderApp(clientId, request);
  if (!access) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  if (!(await canManageMerchantBilling(access))) {
    return NextResponse.json(
      { error: "Only the app owner or platform admin can fund prepaid credits." },
      { status: 403 },
    );
  }

  const body = await request.json().catch(() => ({}));
  const depositWalletAddress = String(body.depositWalletAddress || "").trim();
  const onRampTransactionId = String(body.onRampTransactionId || "").trim();
  const onrampProvider =
    typeof body.onrampProvider === "string" ? body.onrampProvider.trim() : undefined;
  const turnkeyOrganizationId =
    typeof body.turnkeyOrganizationId === "string"
      ? body.turnkeyOrganizationId.trim()
      : undefined;

  // Owner-funding only: credit the signed-in owner, never a client-chosen subject.
  const externalUserId = access.userId;
  // Amount is fixed server-side for the sandbox demo (Turnkey status API has no amount).
  const fiatCurrencyCode = "USD";
  const fiatAmount = SANDBOX_ONRAMP_USD_AMOUNT;

  if (!depositWalletAddress || !onRampTransactionId) {
    return NextResponse.json(
      {
        error: "depositWalletAddress and onRampTransactionId are required",
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
      fiatCurrencyCode,
      fiatAmount,
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
