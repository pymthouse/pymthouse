import { timingSafeEqual } from "node:crypto";
import { NextRequest } from "next/server";
import { clearCookieOptions, openGithubOauthState } from "@/lib/turnkey-github-cookies";
import {
  DISCORD_OAUTH_STATE_COOKIE,
  exchangeDiscordOAuthCode,
  verifyDiscordIdentity,
} from "@/lib/turnkey-discord-auth";
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

function readDiscordCallback(request: NextRequest): {
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
  const csrf = request.cookies.get(DISCORD_OAUTH_STATE_COOKIE)?.value ?? "";
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
    const { state, code } = readDiscordCallback(request);
    const exchanged = await exchangeDiscordOAuthCode(code);
    const identity = await verifyDiscordIdentity({
      accessToken: exchanged.accessToken,
      idToken: exchanged.idToken,
      nonce: state.nonce,
    });
    const response = await redirectForWalletLogin({
      publicKey: state.publicKey,
      callbackUrl: state.callbackUrl,
      login: {
        verifiedEmail: identity.email,
        publicKey: state.publicKey,
        method: "discord",
        name: identity.name,
        discordIdToken: identity.idToken ?? undefined,
      },
    });
    response.cookies.set(DISCORD_OAUTH_STATE_COOKIE, "", clearCookieOptions());
    return response;
  } catch (err) {
    const invalidState = err instanceof Error && err.message === "InvalidOauthState";
    if (!invalidState) console.error("Discord wallet login failed", err);
    const response = walletLoginErrorRedirect(
      invalidState ? "InvalidOauthState" : "DiscordLoginFailed",
    );
    response.cookies.set(DISCORD_OAUTH_STATE_COOKIE, "", clearCookieOptions());
    return response;
  }
}
