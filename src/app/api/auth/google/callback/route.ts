import { timingSafeEqual } from "node:crypto";
import { NextRequest } from "next/server";
import { clearCookieOptions, openGithubOauthState } from "@/lib/turnkey-github-cookies";
import {
  exchangeGoogleOAuthCode,
  GOOGLE_OAUTH_STATE_COOKIE,
  verifyGoogleIdToken,
} from "@/lib/turnkey-google-auth";
import {
  redirectForWalletLogin,
  walletLoginErrorRedirect,
} from "@/lib/turnkey-wallet-route";

export const dynamic = "force-dynamic";

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

export async function GET(request: NextRequest) {
  const rawState = request.nextUrl.searchParams.get("state")?.trim();
  const state = rawState ? openGithubOauthState(rawState) : null;
  const csrf = request.cookies.get(GOOGLE_OAUTH_STATE_COOKIE)?.value;
  const code = request.nextUrl.searchParams.get("code")?.trim();
  if (!state || !csrf || !safeEqual(csrf, state.csrf) || !code) {
    return walletLoginErrorRedirect("InvalidOauthState");
  }
  try {
    const { idToken } = await exchangeGoogleOAuthCode(code);
    const identity = await verifyGoogleIdToken({ idToken, nonce: state.nonce });
    const response = await redirectForWalletLogin({
      publicKey: state.publicKey,
      callbackUrl: state.callbackUrl,
      login: {
        verifiedEmail: identity.email,
        publicKey: state.publicKey,
        method: "google",
        name: identity.name,
        googleIdToken: idToken,
      },
    });
    response.cookies.set(GOOGLE_OAUTH_STATE_COOKIE, "", clearCookieOptions());
    return response;
  } catch (err) {
    console.error("Google wallet login failed", err);
    const response = walletLoginErrorRedirect("GoogleLoginFailed");
    response.cookies.set(GOOGLE_OAUTH_STATE_COOKIE, "", clearCookieOptions());
    return response;
  }
}
