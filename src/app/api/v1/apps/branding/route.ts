import { NextRequest, NextResponse } from "next/server";
import { resolveAppBrandingByClientId, getDefaultBranding } from "@/domains/oidc-platform/runtime/branding";

export async function GET(request: NextRequest): Promise<NextResponse> {
  const clientId = request.nextUrl.searchParams.get("client_id");

  if (!clientId) {
    return NextResponse.json(
      { branding: getDefaultBranding() },
      { headers: { "Cache-Control": "public, max-age=60" } }
    );
  }

  try {
    const branding = await resolveAppBrandingByClientId(clientId);

    if (!branding) {
      return NextResponse.json(
        { branding: getDefaultBranding() },
        { status: 404, headers: { "Cache-Control": "no-store" } }
      );
    }

    return NextResponse.json(
      { 
        branding: {
          mode: branding.mode,
          displayName: branding.displayName,
          logoUrl: branding.logoUrl,
          primaryColor: branding.primaryColor,
          privacyPolicyUrl: branding.privacyPolicyUrl,
          tosUrl: branding.tosUrl,
          supportUrl: branding.supportUrl,
        }
      },
      { headers: { "Cache-Control": "public, max-age=60" } }
    );
  } catch (err) {
    console.error("[branding] Failed to resolve branding:", err);
    return NextResponse.json(
      { error: "Failed to resolve branding" },
      { status: 500, headers: { "Cache-Control": "no-store" } }
    );
  }
}
