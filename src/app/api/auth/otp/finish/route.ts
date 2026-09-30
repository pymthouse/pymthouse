import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/next-auth-options";
import { isTurnkeyBackendAuthEnabled } from "@/lib/turnkey-backend-auth";
import {
  claimVerifiedEmailForUser,
  completeWalletLogin,
} from "@/lib/turnkey-wallet-login";
import {
  otpLoginSignatureMessage,
  type OtpClientSignature,
} from "@/lib/turnkey-otp";
import { openWalletOtp, WALLET_OTP_COOKIE } from "@/lib/turnkey-wallet-handoff";
import {
  jsonForWalletResult,
  walletLoginJsonError,
} from "@/lib/turnkey-wallet-route";

export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  if (!isTurnkeyBackendAuthEnabled()) {
    return NextResponse.json({ error: "Email sign-in is not configured." }, { status: 404 });
  }
  const pending = openWalletOtp(request.cookies.get(WALLET_OTP_COOKIE)?.value);
  if (!pending?.verificationToken) {
    return NextResponse.json({ error: "Verify the email code first." }, { status: 400 });
  }
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const signature =
    typeof body === "object" && body !== null
      ? (body as { signature?: unknown }).signature
      : undefined;
  if (typeof signature !== "string" || !signature.trim()) {
    return NextResponse.json({ error: "Missing signature." }, { status: 400 });
  }
  const signed = otpLoginSignatureMessage({
    verificationToken: pending.verificationToken,
    publicKey: pending.publicKey,
  });
  const clientSignature: OtpClientSignature = {
    message: signed.message,
    publicKey: pending.publicKey,
    scheme: "CLIENT_SIGNATURE_SCHEME_API_P256",
    signature: signature.trim(),
  };
  try {
    const session = await getServerSession(authOptions);
    const sessionUser = session?.user as { id?: string } | undefined;
    if (sessionUser?.id) {
      const claimed = await claimVerifiedEmailForUser({
        userId: sessionUser.id,
        verifiedEmail: pending.email,
        publicKey: pending.publicKey,
        otp: { verificationToken: pending.verificationToken, clientSignature },
      });
      if (claimed.kind === "updated") {
        return NextResponse.json({ redirect: "/onboarding" });
      }
      return jsonForWalletResult(claimed, pending.callbackUrl, pending.publicKey);
    }
    const result = await completeWalletLogin({
      verifiedEmail: pending.email,
      publicKey: pending.publicKey,
      method: "email",
      otp: { verificationToken: pending.verificationToken, clientSignature },
    });
    return jsonForWalletResult(result, pending.callbackUrl, pending.publicKey);
  } catch (err) {
    return walletLoginJsonError(err);
  }
}
