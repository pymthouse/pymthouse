import { NextRequest, NextResponse } from "next/server";
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
    const redirect = `${getPublicOrigin()}/apps/${encodeURIComponent(clientId)}/settings?tab=payments&connected=1`;
    return NextResponse.redirect(redirect);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const redirect = `${getPublicOrigin()}/apps/${encodeURIComponent(clientId)}/settings?tab=payments&error=${encodeURIComponent(message)}`;
    return NextResponse.redirect(redirect);
  }
}
