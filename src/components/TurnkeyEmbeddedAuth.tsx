"use client";

import {
  AuthState,
  ClientState,
  useTurnkey,
} from "@turnkey/react-wallet-kit";
import { useSession } from "next-auth/react";
import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useRef, useState, type CSSProperties } from "react";
import { AuthComponent } from "@/lib/turnkey-auth-component";
import {
  bridgeTurnkeySessionToNextAuth,
  safeCallbackUrl,
} from "@/lib/turnkey-nextauth-bridge";

const DEFAULT_AUTH_LOGO = "/pymthouse-mark.svg";
const DEFAULT_TERMS_URL = "https://www.turnkey.com/legal/terms";
const DEFAULT_PRIVACY_URL = "https://www.turnkey.com/legal/privacy";

export function TurnkeyEmbeddedAuth({
  primaryColor = "#10b981",
  logoUrl,
  title = "Log in or sign up",
}: Readonly<{
  primaryColor?: string;
  /** Image URL shown inside the AuthComponent panel. */
  logoUrl?: string | null;
  title?: string;
}>) {
  const turnkeyConfigured =
    !!process.env.NEXT_PUBLIC_ORGANIZATION_ID?.trim() &&
    !!process.env.NEXT_PUBLIC_AUTH_PROXY_CONFIG_ID?.trim();

  if (!turnkeyConfigured) {
    return (
      <p className="text-xs text-zinc-500 leading-relaxed">
        Turnkey Wallet Kit is not configured. Set{" "}
        <code className="text-zinc-400">NEXT_PUBLIC_ORGANIZATION_ID</code> and{" "}
        <code className="text-zinc-400">NEXT_PUBLIC_AUTH_PROXY_CONFIG_ID</code>{" "}
        in your environment.
      </p>
    );
  }

  return (
    <TurnkeyEmbeddedAuthInner
      primaryColor={primaryColor}
      logoUrl={logoUrl}
      title={title}
    />
  );
}

function TurnkeyEmbeddedAuthInner({
  primaryColor,
  logoUrl,
  title,
}: Readonly<{
  primaryColor: string;
  logoUrl?: string | null;
  title: string;
}>) {
  const {
    authState,
    clientState,
    getSession,
    refreshWallets,
    refreshUser,
    user,
    wallets,
    logout,
  } = useTurnkey();
  const { status: nextAuthStatus } = useSession();
  const router = useRouter();
  const searchParams = useSearchParams();
  const callbackUrl = safeCallbackUrl(searchParams.get("callbackUrl"));

  const [bridging, setBridging] = useState(false);
  const [retryNonce, setRetryNonce] = useState(0);
  const [failed, setFailed] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // True once Turnkey has been Unauthenticated on this page — a later
  // Authenticated state is a fresh login we should bridge to NextAuth.
  const sawUnauthenticated = useRef(false);
  // Only inspect the initial Turnkey session once (avoid logging out mid-bridge).
  const initialSessionHandled = useRef(false);
  const bridgeInFlight = useRef(false);

  // undefined → default pymthouse mark; null/"" → no interior logo (exterior branding).
  const authLogo =
    logoUrl === undefined
      ? DEFAULT_AUTH_LOGO
      : logoUrl?.trim() || undefined;
  const termsUrl =
    process.env.NEXT_PUBLIC_TERMS_URL?.trim() || DEFAULT_TERMS_URL;
  const privacyUrl =
    process.env.NEXT_PUBLIC_PRIVACY_URL?.trim() || DEFAULT_PRIVACY_URL;

  useEffect(() => {
    if (authState === AuthState.Unauthenticated) {
      sawUnauthenticated.current = true;
    }
  }, [authState]);

  // On first Ready tick: clear a leftover Turnkey session so the form is usable.
  // Must not run again after a fresh OTP/passkey login or it races the bridge.
  // Only on /login — never on /auth/callback.
  useEffect(() => {
    if (initialSessionHandled.current) return;
    if (clientState !== ClientState.Ready) return;
    if (nextAuthStatus === "loading") return;

    initialSessionHandled.current = true;

    if (
      nextAuthStatus === "unauthenticated" &&
      authState === AuthState.Authenticated
    ) {
      logout().catch(() => {
        // Ignore — AuthComponent can still proceed after a failed clear.
      });
      return;
    }

    if (authState === AuthState.Unauthenticated) {
      sawUnauthenticated.current = true;
    }
  }, [authState, clientState, logout, nextAuthStatus]);

  // Bridge after a fresh Turnkey authentication (user completed the form).
  useEffect(() => {
    if (authState !== AuthState.Authenticated) return;
    if (nextAuthStatus !== "unauthenticated") return;
    if (!sawUnauthenticated.current) return;
    if (clientState !== ClientState.Ready) return;
    if (failed || bridgeInFlight.current) return;

    bridgeInFlight.current = true;

    (async () => {
      setBridging(true);
      setError(null);
      try {
        const result = await bridgeTurnkeySessionToNextAuth({
          getSession: () => getSession(),
          refreshUser,
          refreshWallets,
          wallets,
          user,
        });

        if (!result.ok) {
          setError(result.error);
          setFailed(true);
          setBridging(false);
          bridgeInFlight.current = false;
          return;
        }

        router.push(callbackUrl);
      } catch (err) {
        const message =
          err instanceof Error ? err.message : "Authentication failed";
        setError(message);
        setFailed(true);
        setBridging(false);
        bridgeInFlight.current = false;
      }
    })().catch(() => {
      setFailed(true);
      setBridging(false);
      bridgeInFlight.current = false;
    });
  }, [
    authState,
    nextAuthStatus,
    clientState,
    failed,
    retryNonce,
    getSession,
    refreshUser,
    refreshWallets,
    router,
    callbackUrl,
    wallets,
    user,
  ]);

  if (clientState === ClientState.Loading) {
    return (
      <p className="text-sm text-zinc-500 animate-pulse text-center py-6">
        Loading sign-in…
      </p>
    );
  }

  if (bridging) {
    return (
      <p className="text-sm text-zinc-400 text-center py-6">Connecting…</p>
    );
  }

  return (
    <div>
      {/*
        Turnkey Auth styles expect the kit's design tokens. OTP / wallet
        sub-steps may still open Turnkey's modal stack; outside-click dismiss
        is blocked by TurnkeyModalDismissGuard.
        Kit hardcodes Terms/Privacy to turnkey.com — hide that footer and
        render env-configurable links below.
      */}
      <div
        className={
          "dark tk-embedded-auth w-full overflow-hidden rounded-lg [&_.w-96]:!w-full [&_>div_>div:last-child]:hidden" +
          // Kit defaults logo to max-w-32/max-h-16; force a readable header size.
          // Also give no-logo spacer less empty top padding (kit uses mt-12).
          (authLogo
            ? " [&_img]:!max-w-[min(100%,14rem)] [&_img]:!max-h-12 [&_img]:!h-12 [&_img]:!w-auto [&_img]:!min-h-12"
            : " [&_.mt-12]:!mt-2")
        }
        style={
          {
            ["--tk-primary"]: primaryColor,
          } as CSSProperties
        }
      >
        <AuthComponent
          title={title}
          {...(authLogo
            ? {
                logo: authLogo,
                logoClassName:
                  "!max-w-[min(100%,14rem)] !max-h-12 !h-12 !w-auto !min-h-12",
              }
            : {})}
        />
      </div>
      <p className="text-xs text-zinc-500 mt-4 text-center leading-relaxed">
        By continuing, you agree to our{" "}
        <a
          href={termsUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="font-medium text-zinc-400 hover:text-zinc-200 transition-colors"
        >
          Terms of Service
        </a>
        {" & "}
        <a
          href={privacyUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="font-medium text-zinc-400 hover:text-zinc-200 transition-colors"
        >
          Privacy Policy
        </a>
        .
      </p>
      {error && (
        <div className="mt-3 space-y-2">
          <p className="text-xs text-red-400 bg-red-500/10 border border-red-500/20 rounded-lg px-3 py-2">
            {error}
          </p>
          {authState === AuthState.Authenticated && (
            <button
              type="button"
              onClick={() => {
                setFailed(false);
                setError(null);
                bridgeInFlight.current = false;
                setRetryNonce((n) => n + 1);
              }}
              className="w-full text-xs text-zinc-400 hover:text-zinc-200 transition-colors"
            >
              Try connecting again
            </button>
          )}
        </div>
      )}
    </div>
  );
}
