import { NextRequest, NextResponse } from "next/server";
import {
  clearCookieOptions,
  GITHUB_SESSION_HANDOFF_COOKIE,
} from "@/lib/turnkey-github-cookies";

export const dynamic = "force-dynamic";

/**
 * One-shot handoff: return the Turnkey session JWT from the short-lived cookie
 * and clear it. Called by `/auth/github/complete` before `storeSession`.
 */
export async function POST(request: NextRequest) {
  const sessionToken = request.cookies
    .get(GITHUB_SESSION_HANDOFF_COOKIE)
    ?.value?.trim();

  if (!sessionToken) {
    return NextResponse.json(
      { error: "No pending GitHub Turnkey session" },
      { status: 404 },
    );
  }

  const response = NextResponse.json({ sessionToken });
  response.cookies.set(GITHUB_SESSION_HANDOFF_COOKIE, "", clearCookieOptions());
  return response;
}
