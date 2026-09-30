import { NextRequest, NextResponse } from "next/server";
import {
  createGithubOauthCsrf,
  githubOauthStateCookieOptions,
  sealGithubOauthState,
} from "@/lib/turnkey-github-cookies";
import { getPublicOrigin } from "@/lib/oidc/issuer-urls";
import { safeCallbackUrl } from "@/lib/turnkey-nextauth-bridge";
import {
  getGoogleOAuthClientId,
  GOOGLE_OAUTH_STATE_COOKIE,
  googleAuthorizeUrl,
  isGoogleWalletLoginConfigured,
} from "@/lib/turnkey-google-auth";
import { isTurnkeyBackendAuthEnabled } from "@/lib/turnkey-backend-auth";
import { turnkeyOauthNonceFromPublicKey } from "@/lib/turnkey-wallet-oidc";

export const dynamic = "force-dynamic";

function fail(code: string): NextResponse {
  const url = new URL("/login", getPublicOrigin());
  url.searchParams.set("error", code);
  return NextResponse.redirect(url);
}

/** Start Google OAuth for wallet-issuer login. Query: publicKey, callbackUrl. */
export async function GET(request: NextRequest) {
  if (!isTurnkeyBackendAuthEnabled() || !isGoogleWalletLoginConfigured()) {
    return fail("GoogleLoginNotConfigured");
  }
  const publicKey = request.nextUrl.searchParams.get("publicKey")?.trim();
  if (!publicKey || !/^[0-9a-fA-F]{66,130}$/.test(publicKey)) {
    return fail("InvalidPublicKey");
  }
  const clientId = getGoogleOAuthClientId();
  if (!clientId) return fail("GoogleLoginNotConfigured");
  const nonce = turnkeyOauthNonceFromPublicKey(publicKey);
  const callbackUrl = safeCallbackUrl(request.nextUrl.searchParams.get("callbackUrl"));
  const csrf = createGithubOauthCsrf();
  const state = sealGithubOauthState({ publicKey, nonce, callbackUrl, csrf });
  const response = NextResponse.redirect(googleAuthorizeUrl({ state, clientId, nonce }));
  response.cookies.set(GOOGLE_OAUTH_STATE_COOKIE, csrf, githubOauthStateCookieOptions());
  return response;
}
