import { NextRequest, NextResponse } from "next/server";
import {
  createGithubOauthCsrf,
  GITHUB_OAUTH_STATE_COOKIE,
  githubOauthStateCookieOptions,
  type GithubOauthIntent,
  sealGithubOauthState,
} from "@/lib/turnkey-github-cookies";
import {
  getGithubOAuthClientId,
  githubAuthorizeUrl,
  isGithubTurnkeyLoginConfigured,
} from "@/lib/turnkey-github-auth";
import { turnkeyOauthNonceFromPublicKey } from "@/lib/turnkey-github-oidc";
import { getPublicOrigin } from "@/lib/oidc/issuer-urls";
import { safeCallbackUrl } from "@/lib/turnkey-nextauth-bridge";

export const dynamic = "force-dynamic";

function oauthErrorRedirect(
  message: string,
  intent: GithubOauthIntent,
): NextResponse {
  const url = new URL(intent === "link" ? "/account" : "/login", getPublicOrigin());
  url.searchParams.set("error", message);
  return NextResponse.redirect(url);
}

/**
 * Start GitHub OAuth for Turnkey wallet login or account linking.
 * Query: publicKey (Turnkey session pubkey), callbackUrl (optional),
 * intent=link to attach GitHub to the current sub-org.
 */
export async function GET(request: NextRequest) {
  const intent: GithubOauthIntent =
    request.nextUrl.searchParams.get("intent") === "link" ? "link" : "login";

  if (!isGithubTurnkeyLoginConfigured()) {
    return oauthErrorRedirect("GitHubLoginNotConfigured", intent);
  }

  const publicKey = request.nextUrl.searchParams.get("publicKey")?.trim();
  if (!publicKey || !/^[0-9a-fA-F]{66,130}$/.test(publicKey)) {
    return oauthErrorRedirect("InvalidPublicKey", intent);
  }

  const clientId = getGithubOAuthClientId();
  if (!clientId) {
    return oauthErrorRedirect("GitHubLoginNotConfigured", intent);
  }

  const nonce = turnkeyOauthNonceFromPublicKey(publicKey);
  const callbackUrl = safeCallbackUrl(
    request.nextUrl.searchParams.get("callbackUrl"),
    intent === "link" ? "/account" : "/onboarding",
  );
  const csrf = createGithubOauthCsrf();
  const state = sealGithubOauthState({
    publicKey,
    nonce,
    callbackUrl,
    csrf,
    intent,
  });

  const response = NextResponse.redirect(
    githubAuthorizeUrl({
      state,
      clientId,
    }),
  );
  response.cookies.set(
    GITHUB_OAUTH_STATE_COOKIE,
    csrf,
    githubOauthStateCookieOptions(),
  );
  return response;
}
