"use client";

import {
  TurnkeyProvider as TurnkeyProviderBase,
  type TurnkeyProviderConfig,
} from "@turnkey/react-wallet-kit";
import { useEffect } from "react";
import { TurnkeyModalDismissGuard } from "./TurnkeyModalDismissGuard";

// Wallet Kit auto-calls fetchUser/fetchWallets on mount whenever it thinks
// a session might exist. On /login (or after a stale/expired session) these
// legitimately fail and surface as generic `TurnkeyError: Failed to fetch …`.
// The kit already handles these internally (triggers logout on SESSION_EXPIRED),
// so they are noise rather than actionable errors.
const BENIGN_TURNKEY_MESSAGES = new Set([
  "Failed to fetch wallets",
  "Failed to fetch user",
]);

// OTP failures are expected user mistakes (wrong code, expired, etc.). The kit
// already renders a friendly inline message ("Invalid OTP code" / "An error has
// occurred"); console.error + rethrows only feed Next.js's dev overlay.
const EXPECTED_USER_TURNKEY_MESSAGES = new Set([
  "Failed to verify OTP",
  "Failed to complete OTP",
  "Failed to initialize OTP",
  "Failed to login with OTP",
  "Failed to sign up with OTP",
]);

const BENIGN_TURNKEY_CODES = new Set([
  "NO_SESSION_FOUND",
  "SESSION_EXPIRED",
  "CLIENT_NOT_INITIALIZED",
  "INVALID_OTP_CODE",
]);

/** Kit OTP UI catches, shows a friendly message, then rethrows → unhandledRejection. */
function rejectionMessage(reason: unknown): string {
  if (reason instanceof Error) return reason.message;
  if (typeof reason === "string") return reason;
  if (reason == null) return "";
  try {
    return JSON.stringify(reason);
  } catch {
    return "";
  }
}

/** Kit wrappers sometimes prefix the same failures ("Error completing OTP: …"). */
const OTP_REJECTION_SUBSTRINGS = [
  "Error completing OTP",
  "Error resending OTP",
  "Error initializing OTP",
] as const;

function isExpectedTurnkeyOtpRejection(reason: unknown): boolean {
  const message = rejectionMessage(reason);
  if (!message) return false;
  if (EXPECTED_USER_TURNKEY_MESSAGES.has(message)) return true;
  if (BENIGN_TURNKEY_MESSAGES.has(message)) return true;
  for (const expected of EXPECTED_USER_TURNKEY_MESSAGES) {
    if (message.includes(expected)) return true;
  }
  for (const benign of BENIGN_TURNKEY_MESSAGES) {
    if (message.includes(benign)) return true;
  }
  return OTP_REJECTION_SUBSTRINGS.some((s) => message.includes(s));
}

function isQuietTurnkeyError(error: unknown): boolean {
  const message = (error as { message?: string })?.message ?? "";
  const code = (error as { code?: string })?.code ?? "";
  return (
    BENIGN_TURNKEY_MESSAGES.has(message) ||
    EXPECTED_USER_TURNKEY_MESSAGES.has(message) ||
    BENIGN_TURNKEY_CODES.has(code)
  );
}

function TurnkeyExpectedErrorGuard() {
  useEffect(() => {
    const onUnhandledRejection = (event: PromiseRejectionEvent) => {
      if (!isExpectedTurnkeyOtpRejection(event.reason)) return;
      event.preventDefault();
      console.debug("Turnkey (expected OTP failure):", event.reason);
    };

    window.addEventListener("unhandledrejection", onUnhandledRejection);
    return () => {
      window.removeEventListener("unhandledrejection", onUnhandledRejection);
    };
  }, []);

  return null;
}

export default function TurnkeyProviderWrapper({
  children,
}: {
  children: React.ReactNode;
}) {
  const organizationId = process.env.NEXT_PUBLIC_ORGANIZATION_ID;
  const authProxyConfigId = process.env.NEXT_PUBLIC_AUTH_PROXY_CONFIG_ID;

  if (!organizationId || !authProxyConfigId) {
    return <>{children}</>;
  }

  const oauthRedirectUri =
    process.env.NEXT_PUBLIC_OAUTH_REDIRECT_URI?.trim() || undefined;

  const turnkeyConfig: TurnkeyProviderConfig = {
    organizationId,
    authProxyConfigId,
    auth: oauthRedirectUri
      ? {
          oauthConfig: {
            oauthRedirectUri,
          },
        }
      : undefined,
    ui: {
      darkMode: true,
      logoDark: "/pymthouse-mark.svg",
      logoLight: "/pymthouse-mark.svg",
    },
  };

  return (
    <TurnkeyProviderBase
      config={turnkeyConfig}
      callbacks={{
        onError: (error) => {
          if (isQuietTurnkeyError(error)) {
            const message = (error as { message?: string })?.message ?? "";
            const code = (error as { code?: string })?.code ?? "";
            console.debug("Turnkey (expected):", code || message);
            return;
          }
          console.error("Turnkey error:", error);
        },
      }}
    >
      <TurnkeyModalDismissGuard />
      <TurnkeyExpectedErrorGuard />
      {children}
    </TurnkeyProviderBase>
  );
}
