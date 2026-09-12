import { NextRequest, NextResponse } from "next/server";
import {
  clearCookieOptions,
  GITHUB_OIDC_HANDOFF_COOKIE,
} from "@/lib/turnkey-github-cookies";

export const dynamic = "force-dynamic";

/**
 * One-shot handoff: return the GitHub OIDC token minted for account linking
 * and clear it. Called by `/account` before `addOauthProvider`.
 */
export async function POST(request: NextRequest) {
  const oidcToken = request.cookies
    .get(GITHUB_OIDC_HANDOFF_COOKIE)
    ?.value?.trim();

  if (!oidcToken) {
    return NextResponse.json(
      { error: "No pending GitHub OIDC token" },
      { status: 404 },
    );
  }

  const response = NextResponse.json({ oidcToken });
  response.cookies.set(GITHUB_OIDC_HANDOFF_COOKIE, "", clearCookieOptions());
  return response;
}
