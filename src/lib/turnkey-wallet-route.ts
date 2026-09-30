import { NextResponse } from "next/server";
import { clearCookieOptions } from "@/lib/turnkey-github-cookies";
import { getPublicOrigin } from "@/lib/oidc/issuer-urls";
import { safeCallbackUrl } from "@/lib/turnkey-nextauth-bridge";
import {
  completeWalletLogin,
  maskEmail,
  WalletLoginError,
  type WalletLoginInput,
  type WalletLoginResult,
} from "@/lib/turnkey-wallet-login";
import {
  handoffFromLoginResult,
  sealWalletConfirm,
  WALLET_CONFIRM_COOKIE,
  WALLET_HANDOFF_COOKIE,
  WALLET_OTP_COOKIE,
  walletHandoffCookieOptions,
  walletOtpCookieOptions,
} from "@/lib/turnkey-wallet-handoff";

export function walletLoginErrorRedirect(code: string): NextResponse {
  const url = new URL("/login", getPublicOrigin());
  url.searchParams.set("error", code);
  const response = NextResponse.redirect(url);
  response.cookies.set(WALLET_OTP_COOKIE, "", clearCookieOptions());
  return response;
}

export function walletLoginJsonError(err: unknown): NextResponse {
  if (err instanceof WalletLoginError) {
    const status = err.code === "email_conflict" ? 409 : 400;
    return NextResponse.json({ error: err.message, code: err.code }, { status });
  }
  console.error("wallet login failed", err);
  return NextResponse.json({ error: "Sign-in failed. Please try again." }, { status: 500 });
}

export async function redirectForWalletLogin(input: {
  login: WalletLoginInput;
  callbackUrl?: string | null;
  publicKey: string;
}): Promise<NextResponse> {
  const callbackUrl = safeCallbackUrl(input.callbackUrl);
  try {
    const result = await completeWalletLogin(input.login);
    return responseForWalletResult(result, callbackUrl, input.publicKey);
  } catch (err) {
    if (err instanceof WalletLoginError) {
      return walletLoginErrorRedirect(err.code);
    }
    console.error("wallet login failed", err);
    return walletLoginErrorRedirect("WalletLoginFailed");
  }
}

export function responseForWalletResult(
  result: WalletLoginResult,
  callbackUrl: string,
  publicKey: string,
): NextResponse {
  if (result.kind === "confirm-email") {
    const url = new URL("/login", getPublicOrigin());
    url.searchParams.set("step", "confirm");
    url.searchParams.set("callbackUrl", callbackUrl);
    const response = NextResponse.redirect(url);
    response.cookies.set(
      WALLET_CONFIRM_COOKIE,
      sealWalletConfirm({
        email: result.email,
        subOrganizationId: result.subOrganizationId,
        publicKey,
        callbackUrl,
      }),
      walletOtpCookieOptions(),
    );
    response.cookies.set(WALLET_OTP_COOKIE, "", clearCookieOptions());
    return response;
  }
  const sealed = handoffFromLoginResult(result, callbackUrl);
  const url = new URL("/auth/wallet/complete", getPublicOrigin());
  url.searchParams.set("callbackUrl", callbackUrl);
  const response = NextResponse.redirect(url);
  if (sealed && "cookie" in sealed) {
    response.cookies.set(WALLET_HANDOFF_COOKIE, sealed.cookie, walletHandoffCookieOptions());
  }
  response.cookies.set(WALLET_CONFIRM_COOKIE, "", clearCookieOptions());
  response.cookies.set(WALLET_OTP_COOKIE, "", clearCookieOptions());
  return response;
}

export function jsonForWalletResult(
  result: WalletLoginResult,
  callbackUrl: string,
  publicKey: string,
): NextResponse {
  if (result.kind === "confirm-email") {
    const response = NextResponse.json({
      step: "confirm",
      maskedEmail: maskEmail(result.email),
    });
    response.cookies.set(
      WALLET_CONFIRM_COOKIE,
      sealWalletConfirm({
        email: result.email,
        subOrganizationId: result.subOrganizationId,
        publicKey,
        callbackUrl,
      }),
      walletOtpCookieOptions(),
    );
    return response;
  }
  const sealed = handoffFromLoginResult(result, callbackUrl);
  const response = NextResponse.json({
    redirect: `/auth/wallet/complete?callbackUrl=${encodeURIComponent(callbackUrl)}`,
  });
  if (sealed && "cookie" in sealed) {
    response.cookies.set(WALLET_HANDOFF_COOKIE, sealed.cookie, walletHandoffCookieOptions());
  }
  response.cookies.set(WALLET_OTP_COOKIE, "", clearCookieOptions());
  response.cookies.set(WALLET_CONFIRM_COOKIE, "", clearCookieOptions());
  return response;
}
