import { NextRequest, NextResponse } from "next/server";
import {
  createGithubOauthCsrf,
  GITHUB_OAUTH_STATE_COOKIE,
  githubOauthStateCookieOptions,
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

function loginErrorRedirect(message: string): NextResponse {
  const url = new URL("/login", getPublicOrigin());
  url.searchParams.set("error", message);
  return NextResponse.redirect(url);
}

/**
 * Start GitHub OAuth for Turnkey wallet login.
 * Query: publicKey (Turnkey session pubkey), callbackUrl (optional).
 */
export async function GET(request: NextRequest) {
  if (!isGithubTurnkeyLoginConfigured()) {
    return loginErrorRedirect("GitHubLoginNotConfigured");
  }

  const publicKey = request.nextUrl.searchParams.get("publicKey")?.trim();
  if (!publicKey || !/^[0-9a-fA-F]{66,130}$/.test(publicKey)) {
    return loginErrorRedirect("InvalidPublicKey");
  }

  const clientId = getGithubOAuthClientId();
  if (!clientId) {
    return loginErrorRedirect("GitHubLoginNotConfigured");
  }

  const nonce = turnkeyOauthNonceFromPublicKey(publicKey);
  const callbackUrl = safeCallbackUrl(
    request.nextUrl.searchParams.get("callbackUrl"),
  );
  const csrf = createGithubOauthCsrf();
  const state = sealGithubOauthState({
    publicKey,
    nonce,
    callbackUrl,
    csrf,
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
