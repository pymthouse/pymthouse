import { NextRequest, NextResponse } from "next/server";
import { getPublicOrigin } from "@/lib/oidc/issuer-urls";
import { completeMerchantConnectOAuth } from "@/lib/stripe/merchant-connect";
import {
  merchantConnectOAuthErrorCode,
  sanitizeStripeOAuthProviderError,
} from "@/lib/stripe/webhook";
import { sanitizeForLog } from "@/lib/sanitize-for-log";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id: clientId } = await params;
  const origin = getPublicOrigin();
  const paymentsUrl = `${origin}/apps/${encodeURIComponent(clientId)}/settings?tab=payments`;

  const code = request.nextUrl.searchParams.get("code")?.trim() || "";
  const state = request.nextUrl.searchParams.get("state")?.trim() || "";
  const oauthError = request.nextUrl.searchParams.get("error")?.trim();

  if (oauthError) {
    return NextResponse.redirect(
      `${paymentsUrl}&error=${encodeURIComponent(
        sanitizeStripeOAuthProviderError(oauthError),
      )}`,
    );
  }
  if (!code || !state) {
    return NextResponse.redirect(
      `${paymentsUrl}&error=${encodeURIComponent("missing_oauth_params")}`,
    );
  }

  try {
    await completeMerchantConnectOAuth({ clientId, state, code });
    return NextResponse.redirect(`${paymentsUrl}&connected=1`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(
      "[stripe-connect-oauth]",
      "callback failed:",
      sanitizeForLog(message),
    );
    return NextResponse.redirect(
      `${paymentsUrl}&error=${encodeURIComponent(
        merchantConnectOAuthErrorCode(err),
      )}`,
    );
  }
}
