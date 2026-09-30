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

function readGoogleCallback(request: NextRequest): {
  state: NonNullable<ReturnType<typeof openGithubOauthState>>;
  code: string;
} {
  const rawState = request.nextUrl.searchParams.get("state")?.trim() ?? "";
  if (!rawState) {
    throw new Error("InvalidOauthState");
  }
  const state = openGithubOauthState(rawState);
  if (!state) {
    throw new Error("InvalidOauthState");
  }
  const csrf = request.cookies.get(GOOGLE_OAUTH_STATE_COOKIE)?.value ?? "";
  if (!csrf) {
    throw new Error("InvalidOauthState");
  }
  if (!safeEqual(csrf, state.csrf)) {
    throw new Error("InvalidOauthState");
  }
  const code = request.nextUrl.searchParams.get("code")?.trim() ?? "";
  if (!code) {
    throw new Error("InvalidOauthState");
  }
  return { state, code };
}

export async function GET(request: NextRequest) {
  try {
    const { state, code } = readGoogleCallback(request);
    const { idToken } = await exchangeGoogleOAuthCode(code);
    const identity = await verifyGoogleIdToken({ idToken, nonce: state.nonce });
    const response = await redirectForWalletLogin({
      publicKey: state.publicKey,
      callbackUrl: state.callbackUrl,
      login: {
        verifiedEmail: identity.email,
        publicKey: state.publicKey,
        nonce: state.nonce,
        method: "google",
        name: identity.name,
        googleIdToken: idToken,
      },
    });
    response.cookies.set(GOOGLE_OAUTH_STATE_COOKIE, "", clearCookieOptions());
    return response;
  } catch (err) {
    const invalidState = err instanceof Error && err.message === "InvalidOauthState";
    if (!invalidState) console.error("Google wallet login failed", err);
    const response = walletLoginErrorRedirect(
      invalidState ? "InvalidOauthState" : "GoogleLoginFailed",
    );
    response.cookies.set(GOOGLE_OAUTH_STATE_COOKIE, "", clearCookieOptions());
    return response;
  }
}
