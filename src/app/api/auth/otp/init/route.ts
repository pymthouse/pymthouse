import { NextRequest, NextResponse } from "next/server";
import { clientIpFromRequest } from "@/lib/client-ip";
import { getTurnkeyServerApiClient } from "@/lib/onramp/turnkey-client";
import { assertBucketRateLimit, BucketRateLimitError } from "@/lib/bucket-rate-limit";
import { isTurnkeyBackendAuthEnabled } from "@/lib/turnkey-backend-auth";
import { normalizeTurnkeyEmail } from "@/lib/turnkey";
import { safeCallbackUrl } from "@/lib/turnkey-nextauth-bridge";
import {
  openWalletConfirm,
  sealWalletOtp,
  WALLET_CONFIRM_COOKIE,
  WALLET_OTP_COOKIE,
  walletOtpCookieOptions,
} from "@/lib/turnkey-wallet-handoff";

export const dynamic = "force-dynamic";

const WINDOW_MS = 10 * 60 * 1000;

function parentOrganizationId(): string {
  return (
    process.env.TURNKEY_ORG_ID?.trim() ||
    process.env.NEXT_PUBLIC_ORGANIZATION_ID?.trim() ||
    ""
  );
}

export async function POST(request: NextRequest) {
  if (!isTurnkeyBackendAuthEnabled()) {
    return NextResponse.json({ error: "Email sign-in is not configured." }, { status: 404 });
  }
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const obj = typeof body === "object" && body !== null ? (body as Record<string, unknown>) : {};
  const confirmed = obj.confirm === true
    ? openWalletConfirm(request.cookies.get(WALLET_CONFIRM_COOKIE)?.value)
    : null;
  if (obj.confirm === true && !confirmed) {
    return NextResponse.json({ error: "This sign-in expired. Start again." }, { status: 400 });
  }
  const email = normalizeTurnkeyEmail(
    confirmed?.email ?? (typeof obj.email === "string" ? obj.email : ""),
  );
  const publicKey = (confirmed?.publicKey ?? (typeof obj.publicKey === "string" ? obj.publicKey : "")).trim();
  const callbackUrl = confirmed?.callbackUrl ?? (typeof obj.callbackUrl === "string" ? obj.callbackUrl : null);
  if (!email || !email.includes("@") || email.endsWith("@turnkey.local") || !/^[0-9a-fA-F]{66,130}$/.test(publicKey)) {
    return NextResponse.json({ error: "A valid email and session key are required." }, { status: 400 });
  }
  const organizationId = parentOrganizationId();
  if (!organizationId) {
    return NextResponse.json({ error: "Turnkey is not configured." }, { status: 500 });
  }
  try {
    const ip = clientIpFromRequest(request);
    if (ip !== "unknown") {
      await assertBucketRateLimit(`otp:ip:${ip}`, 20, WINDOW_MS);
    }
    await assertBucketRateLimit(`otp:email:${email}`, 5, WINDOW_MS);
  } catch (err) {
    if (err instanceof BucketRateLimitError) {
      return NextResponse.json({ error: err.message }, { status: 429 });
    }
    throw err;
  }
  const init = await getTurnkeyServerApiClient().initOtp({
    organizationId,
    otpType: "OTP_TYPE_EMAIL",
    contact: email,
    appName: "PymtHouse",
    alphanumeric: false,
    otpLength: 6,
  });
  const response = NextResponse.json({ ok: true });
  response.cookies.set(
    WALLET_OTP_COOKIE,
    sealWalletOtp({
      otpId: init.otpId,
      otpEncryptionTargetBundle: init.otpEncryptionTargetBundle,
      email,
      publicKey,
      callbackUrl: safeCallbackUrl(callbackUrl),
    }),
    walletOtpCookieOptions(),
  );
  return response;
}
