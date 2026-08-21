import { NextRequest, NextResponse } from "next/server";
import { appSettingsAbsoluteUrl } from "@/lib/apps/settings-paths";
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

  const code = request.nextUrl.searchParams.get("code")?.trim() || "";
  const state = request.nextUrl.searchParams.get("state")?.trim() || "";
  const oauthError = request.nextUrl.searchParams.get("error")?.trim() || "";

  // Authorization is the server-side OAuth state + Stripe code exchange inside
  // completeMerchantConnectOAuth — not the absence of a provider `error` param.
  // Only use `error` for UX when code/state are missing (OAuth denial / cancel).
  // The sanitizer maps the provider error (including empty) to a fixed constant,
  // so no user-controlled value branches here or reaches the redirect.
  if (!code || !state) {
    const errorCode = sanitizeStripeOAuthProviderError(oauthError);
    return NextResponse.redirect(
      appSettingsAbsoluteUrl(origin, clientId, "payments", {
        error: errorCode,
      }),
    );
  }

  try {
    await completeMerchantConnectOAuth({ clientId, state, code });
    return NextResponse.redirect(
      appSettingsAbsoluteUrl(origin, clientId, "payments", {
        connected: "1",
      }),
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(
      "[stripe-connect-oauth]",
      "callback failed:",
      sanitizeForLog(message),
    );
    return NextResponse.redirect(
      appSettingsAbsoluteUrl(origin, clientId, "payments", {
        error: merchantConnectOAuthErrorCode(err),
      }),
    );
  }
}
