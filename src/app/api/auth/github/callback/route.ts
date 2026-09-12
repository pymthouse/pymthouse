import { timingSafeEqual } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import {
  clearCookieOptions,
  GITHUB_OAUTH_STATE_COOKIE,
  GITHUB_OIDC_HANDOFF_COOKIE,
  GITHUB_SESSION_HANDOFF_COOKIE,
  type GithubOauthIntent,
  githubOidcHandoffCookieOptions,
  githubSessionHandoffCookieOptions,
  openGithubOauthState,
} from "@/lib/turnkey-github-cookies";
import {
  exchangeGithubOAuthCode,
  fetchGithubUserProfile,
  GITHUB_ACCOUNT_EXISTS_ERROR,
  isExistingAccountError,
  isGithubTurnkeyLoginConfigured,
  loginTurnkeyWithGithub,
} from "@/lib/turnkey-github-auth";
import { mintTurnkeyGithubOidcToken } from "@/lib/turnkey-github-oidc";
import { getPublicOrigin } from "@/lib/oidc/issuer-urls";
import { safeCallbackUrl } from "@/lib/turnkey-nextauth-bridge";

export const dynamic = "force-dynamic";

function redirectWithOauthError(
  error: string,
  intent: GithubOauthIntent = "login",
  email?: string,
): NextResponse {
  const url = new URL(intent === "link" ? "/account" : "/login", getPublicOrigin());
  url.searchParams.set("error", error);
  if (email) url.searchParams.set("email", email);
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

function parseGithubCallbackOrThrow(request: NextRequest): {
  state: NonNullable<ReturnType<typeof openGithubOauthState>>;
  code: string;
} {
  const rawState = request.nextUrl.searchParams.get("state");
  if (!rawState) {
    throw new Error("InvalidOauthState");
  }
  const state = openGithubOauthState(rawState.trim());
  if (!state) {
    throw new Error("InvalidOauthState");
  }
  const csrfCookie = request.cookies.get(GITHUB_OAUTH_STATE_COOKIE)?.value;
  if (!csrfCookie || !safeEqualString(csrfCookie, state.csrf)) {
    throw new Error("InvalidOauthState");
  }

  const rawCode = request.nextUrl.searchParams.get("code");
  if (!rawCode) {
    throw new Error("InvalidGithubCallback");
  }
  const code = rawCode.trim();
  if (!code) {
    throw new Error("InvalidGithubCallback");
  }

  return {
    state,
    code,
  };
}

/** GitHub OAuth callback → Turnkey oauthLogin or link-token handoff. */
export async function GET(request: NextRequest) {
  if (!isGithubTurnkeyLoginConfigured()) {
    return redirectWithOauthError("GitHubLoginNotConfigured");
  }

  let intent: GithubOauthIntent = "login";
  try {
    // Validate state/CSRF + code before any OAuth exchange side effects.
    const { state, code } = parseGithubCallbackOrThrow(request);
    intent = state.intent;
    const { accessToken } = await exchangeGithubOAuthCode(code);
    const profile = await fetchGithubUserProfile(accessToken);

    if (state.intent === "link") {
      const oidcToken = await mintTurnkeyGithubOidcToken({
        githubUserId: profile.id,
        nonce: state.nonce,
        email: profile.email,
        name: profile.name,
        login: profile.login,
      });
      const accountUrl = new URL(
        safeCallbackUrl(state.callbackUrl, "/account"),
        getPublicOrigin(),
      );
      accountUrl.searchParams.set("link", "github");
      const response = NextResponse.redirect(accountUrl);
      response.cookies.set(GITHUB_OAUTH_STATE_COOKIE, "", clearCookieOptions());
      response.cookies.set(
        GITHUB_OIDC_HANDOFF_COOKIE,
        oidcToken,
        githubOidcHandoffCookieOptions(),
      );
      return response;
    }

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
    if (isExistingAccountError(err)) {
      return redirectWithOauthError(
        GITHUB_ACCOUNT_EXISTS_ERROR,
        intent,
        err.email,
      );
    }
    console.error("GitHub Turnkey login failed:", err);
    return redirectWithOauthError("GitHubTurnkeyLoginFailed", intent);
  }
}
