import { NextRequest, NextResponse } from "next/server";
import { appSettingsAbsoluteUrl } from "@/lib/apps/settings-paths";
import { getAuthorizedProviderApp } from "@/lib/provider-apps";
import { completeStripeOAuthCallback } from "@/lib/openmeter/stripe-app-install";
import { getPublicOrigin } from "@/lib/oidc/issuer-urls";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id: clientId } = await params;
  const auth = await getAuthorizedProviderApp(clientId, request);
  if (!auth) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const state = request.nextUrl.searchParams.get("state")?.trim();
  const code = request.nextUrl.searchParams.get("code")?.trim() || "";
  const oauthError = request.nextUrl.searchParams.get("error")?.trim() || "";
  const oauthErrorDescription =
    request.nextUrl.searchParams.get("error_description")?.trim() || "";
  if (!state) {
    return NextResponse.json({ error: "Missing state" }, { status: 400 });
  }

  try {
    await completeStripeOAuthCallback({
      clientId: auth.app.id,
      state,
      userId: auth.userId,
      oauthParams: {
        code,
        state,
        error: oauthError,
        errorDescription: oauthErrorDescription,
      },
    });
    return NextResponse.redirect(
      appSettingsAbsoluteUrl(getPublicOrigin(), clientId, "payments", {
        connected: "1",
      }),
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.redirect(
      appSettingsAbsoluteUrl(getPublicOrigin(), clientId, "payments", {
        error: message,
      }),
    );
  }
}
