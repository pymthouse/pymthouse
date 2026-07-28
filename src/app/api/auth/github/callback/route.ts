import { timingSafeEqual } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import {
  clearCookieOptions,
  GITHUB_OAUTH_STATE_COOKIE,
  GITHUB_SESSION_HANDOFF_COOKIE,
  githubSessionHandoffCookieOptions,
  openGithubOauthState,
} from "@/lib/turnkey-github-cookies";
import {
  exchangeGithubOAuthCode,
  fetchGithubUserProfile,
  isGithubTurnkeyLoginConfigured,
  loginTurnkeyWithGithub,
} from "@/lib/turnkey-github-auth";
import { getPublicOrigin } from "@/lib/oidc/issuer-urls";

export const dynamic = "force-dynamic";

function redirectToLogin(error: string): NextResponse {
  const url = new URL("/login", getPublicOrigin());
  url.searchParams.set("error", error);
  const response = NextResponse.redirect(url);
  response.cookies.set(GITHUB_OAUTH_STATE_COOKIE, "", clearCookieOptions());
  return response;
}

function safeEqualString(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

/** GitHub OAuth callback → Turnkey oauthLogin → handoff cookie → complete page. */
export async function GET(request: NextRequest) {
  if (!isGithubTurnkeyLoginConfigured()) {
    return redirectToLogin("GitHubLoginNotConfigured");
  }

  const errorParam = request.nextUrl.searchParams.get("error");
  if (errorParam) {
    return redirectToLogin("AccessDenied");
  }

  const code = request.nextUrl.searchParams.get("code")?.trim();
  const stateParam = request.nextUrl.searchParams.get("state")?.trim();
  if (!code || !stateParam) {
    return redirectToLogin("InvalidGithubCallback");
  }

  const state = openGithubOauthState(stateParam);
  if (!state) {
    return redirectToLogin("InvalidOauthState");
  }

  const csrfCookie = request.cookies.get(GITHUB_OAUTH_STATE_COOKIE)?.value;
  if (!csrfCookie || !safeEqualString(csrfCookie, state.csrf)) {
    return redirectToLogin("InvalidOauthState");
  }

  try {
    const { accessToken } = await exchangeGithubOAuthCode(code);
    const profile = await fetchGithubUserProfile(accessToken);
    const { sessionToken } = await loginTurnkeyWithGithub({
      publicKey: state.publicKey,
      nonce: state.nonce,
      profile,
    });

    const completeUrl = new URL("/auth/github/complete", getPublicOrigin());
    completeUrl.searchParams.set("callbackUrl", state.callbackUrl);

    const response = NextResponse.redirect(completeUrl);
    response.cookies.set(GITHUB_OAUTH_STATE_COOKIE, "", clearCookieOptions());
    response.cookies.set(
      GITHUB_SESSION_HANDOFF_COOKIE,
      sessionToken,
      githubSessionHandoffCookieOptions(),
    );
    return response;
  } catch (err) {
    console.error("GitHub Turnkey login failed:", err);
    return redirectToLogin("GitHubTurnkeyLoginFailed");
  }
}
