import { timingSafeEqual } from "node:crypto";
import {
  githubAuthCookieOptions,
  signPayload,
} from "@/lib/turnkey-github-cookies";
import type { WalletLoginResult } from "@/lib/turnkey-wallet-login";

const OTP_MAX_AGE_SEC = 10 * 60;
const HANDOFF_MAX_AGE_SEC = 120;

export const WALLET_HANDOFF_COOKIE = "pmth_wallet_handoff";
export const WALLET_CONFIRM_COOKIE = "pmth_wallet_confirm";
export const WALLET_OTP_COOKIE = "pmth_wallet_otp";

export type WalletHandoffPayload = {
  sessionToken: string;
  callbackUrl: string;
  attach?: {
    organizationId: string;
    turnkeyUserId: string;
    registrationToken: string;
  };
  exp: number;
};

export type WalletConfirmPayload = {
  email: string;
  subOrganizationId: string;
  publicKey: string;
  callbackUrl: string;
  exp: number;
};

export type WalletOtpPayload = {
  otpId: string;
  otpEncryptionTargetBundle: string;
  email: string;
  publicKey: string;
  callbackUrl: string;
  exp: number;
  verificationToken?: string;
};

function seal(body: unknown): string {
  const encoded = Buffer.from(JSON.stringify(body), "utf8").toString("base64url");
  return `${encoded}.${signPayload(encoded)}`;
}

function openSealed(sealed: string | undefined): unknown {
  if (!sealed) return null;
  const parts = sealed.split(".");
  if (parts.length !== 2 || !parts[0] || !parts[1]) return null;
  const [encoded, sig] = parts;
  const expected = signPayload(encoded);
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  try {
    const parsed: unknown = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
    if (typeof parsed !== "object" || parsed === null) return null;
    const exp = (parsed as { exp?: unknown }).exp;
    if (typeof exp !== "number" || exp < Date.now()) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function sealWalletHandoff(
  input: Omit<WalletHandoffPayload, "exp"> & { exp?: number },
): string {
  return seal({ ...input, exp: input.exp ?? Date.now() + HANDOFF_MAX_AGE_SEC * 1000 });
}

export function openWalletHandoff(sealed: string | undefined): WalletHandoffPayload | null {
  const parsed = openSealed(sealed);
  if (!parsed || typeof parsed !== "object") return null;
  const obj = parsed as WalletHandoffPayload;
  if (typeof obj.sessionToken !== "string" || typeof obj.callbackUrl !== "string") return null;
  return obj;
}

export function sealWalletConfirm(input: Omit<WalletConfirmPayload, "exp">): string {
  return seal({ ...input, exp: Date.now() + OTP_MAX_AGE_SEC * 1000 });
}

export function openWalletConfirm(sealed: string | undefined): WalletConfirmPayload | null {
  const parsed = openSealed(sealed);
  if (!parsed || typeof parsed !== "object") return null;
  const obj = parsed as WalletConfirmPayload;
  if (
    typeof obj.email !== "string" ||
    typeof obj.subOrganizationId !== "string" ||
    typeof obj.publicKey !== "string"
  ) {
    return null;
  }
  return obj;
}

export function sealWalletOtp(input: Omit<WalletOtpPayload, "exp"> & { exp?: number }): string {
  return seal({ ...input, exp: input.exp ?? Date.now() + OTP_MAX_AGE_SEC * 1000 });
}

export function openWalletOtp(sealed: string | undefined): WalletOtpPayload | null {
  const parsed = openSealed(sealed);
  if (!parsed || typeof parsed !== "object") return null;
  const obj = parsed as WalletOtpPayload;
  if (
    typeof obj.otpId !== "string" ||
    typeof obj.otpEncryptionTargetBundle !== "string" ||
    typeof obj.email !== "string" ||
    typeof obj.publicKey !== "string"
  ) {
    return null;
  }
  return obj;
}

export function walletHandoffCookieOptions() {
  return githubAuthCookieOptions(HANDOFF_MAX_AGE_SEC);
}

export function walletOtpCookieOptions() {
  return githubAuthCookieOptions(OTP_MAX_AGE_SEC);
}

export function handoffFromLoginResult(
  result: WalletLoginResult,
  callbackUrl: string,
): { cookie: string } | { confirm: WalletConfirmPayload } | null {
  if (result.kind === "confirm-email") return null;
  if (result.kind === "session") {
    return {
      cookie: sealWalletHandoff({
        sessionToken: result.sessionToken,
        callbackUrl,
      }),
    };
  }
  return {
    cookie: sealWalletHandoff({
      sessionToken: result.sessionToken,
      callbackUrl,
      attach: {
        organizationId: result.subOrganizationId,
        turnkeyUserId: result.turnkeyUserId,
        registrationToken: result.registrationToken,
      },
    }),
  };
}
