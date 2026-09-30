import { NextRequest, NextResponse } from "next/server";
import { encryptOtpCodeToBundle } from "@turnkey/crypto";
import { getTurnkeyServerApiClient } from "@/lib/onramp/turnkey-client";
import { isTurnkeyBackendAuthEnabled } from "@/lib/turnkey-backend-auth";
import { otpLoginSignatureMessage } from "@/lib/turnkey-otp";
import {
  openWalletOtp,
  sealWalletOtp,
  WALLET_OTP_COOKIE,
  walletOtpCookieOptions,
} from "@/lib/turnkey-wallet-handoff";

export const dynamic = "force-dynamic";

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
  const pending = openWalletOtp(request.cookies.get(WALLET_OTP_COOKIE)?.value);
  if (!pending) {
    return NextResponse.json({ error: "Email code expired. Request a new one." }, { status: 400 });
  }
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const rawCode =
    typeof body === "object" && body !== null
      ? (body as { code?: unknown }).code
      : undefined;
  const code = typeof rawCode === "string" ? rawCode.trim() : "";
  if (!/^\d{6}$/.test(code)) {
    return NextResponse.json({ error: "Enter the 6-digit code." }, { status: 400 });
  }
  try {
    const encryptedOtpBundle = await encryptOtpCodeToBundle(
      code,
      pending.otpEncryptionTargetBundle,
      pending.publicKey,
    );
    const verified = await getTurnkeyServerApiClient().verifyOtp({
      organizationId: parentOrganizationId(),
      otpId: pending.otpId,
      encryptedOtpBundle,
    });
    const { message } = otpLoginSignatureMessage({
      verificationToken: verified.verificationToken,
      publicKey: pending.publicKey,
    });
    const response = NextResponse.json({ signatureMessage: message });
    response.cookies.set(
      WALLET_OTP_COOKIE,
      sealWalletOtp({
        ...pending,
        verificationToken: verified.verificationToken,
      }),
      walletOtpCookieOptions(),
    );
    return response;
  } catch (err) {
    const message = err instanceof Error ? err.message : "Invalid code";
    const status = /invalid otp/i.test(message) ? 400 : 500;
    return NextResponse.json(
      { error: status === 400 ? "That code is invalid or expired." : "Could not verify the code." },
      { status },
    );
  }
}
