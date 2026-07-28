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
import { GitHubTurnkeyLoginButton } from "@/components/GitHubTurnkeyLoginButton";
import {
  bridgeTurnkeySessionToNextAuth,
  safeCallbackUrl,
} from "@/lib/turnkey-nextauth-bridge";

const DEFAULT_AUTH_LOGO = "/pymthouse-mark.svg";

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
  const authSectionRef = useRef<HTMLElement | null>(null);
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

  useEffect(() => {
    if (authState === AuthState.Unauthenticated) {
      sawUnauthenticated.current = true;
    }
  }, [authState]);

  useEffect(() => {
    const applyGrouping = () => {
      const section = authSectionRef.current;
      const rootElement = section?.querySelector(":scope > div > div.w-full") as
        | HTMLElement
        | null;
      if (!rootElement) return;

      const googleButton = rootElement.querySelector(
        "button[data-testid='oauth-google']",
      ) as HTMLButtonElement | null;
      const walletButton = rootElement.querySelector(
        "button[data-testid='wallet-auth-button']",
      ) as HTMLButtonElement | null;
      if (!googleButton || !walletButton) return;

      const googleGroup = googleButton.closest("div.w-full") as HTMLElement | null;
      if (googleGroup) googleGroup.style.display = "none";
      const walletGroup = walletButton.closest("div.w-full") as HTMLElement | null;
      if (walletGroup) walletGroup.style.display = "none";

      rootElement
        .querySelectorAll("div.flex.flex-row.w-full.items-center.justify-center.my-4")
        .forEach((divider) => {
          (divider as HTMLElement).style.display = "none";
        });

      rootElement.querySelectorAll("div.text-xs.text-center").forEach((block) => {
        if (!block.textContent?.includes("By continuing, you agree to our")) return;
        (block as HTMLElement).style.display = "none";
      });
    };

    applyGrouping();
    const observer = new MutationObserver(() => {
      applyGrouping();
    });
    const section = authSectionRef.current;
    if (section) {
      observer.observe(section, {
        childList: true,
        subtree: true,
      });
    }
    return () => observer.disconnect();
  }, [clientState, authState, retryNonce]);

  const triggerEmbeddedAuthAction = (testId: string) => {
    const target = authSectionRef.current?.querySelector(
      `button[data-testid='${testId}']`,
    ) as HTMLButtonElement | null;
    target?.click();
  };

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
          "dark tk-embedded-auth w-full overflow-hidden rounded-lg [&_.w-96]:!w-full [&_>div_>div:last-child]:hidden [&_button[data-testid='oauth-google']]:hidden [&_button[data-testid='wallet-auth-button']]:hidden [&_div.flex.flex-row.w-full.items-center.justify-center.my-4]:hidden [&_div.text-icon-text-light\\/70.dark\\:text-icon-text-dark\\/70.text-xs.mt-4.text-center]:hidden" +
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
        <section aria-label="Sign in with" className="mb-4 space-y-2">
          <p className="text-[11px] font-medium uppercase tracking-[0.18em] text-zinc-500">
            Sign in with
          </p>
          <button
            type="button"
            onClick={() => {
              triggerEmbeddedAuthAction("oauth-google");
            }}
            className="flex w-full items-center justify-center gap-2 rounded-lg border border-zinc-700 bg-zinc-950/60 px-4 py-2.5 text-sm font-medium text-zinc-100 transition-colors hover:border-zinc-500 hover:bg-zinc-900"
          >
            Continue with Google
          </button>
          <GitHubTurnkeyLoginButton
            primaryColor={primaryColor}
            sectionLabel={null}
            containerClassName="space-y-2"
          />
        </section>
        <p className="mb-2 text-[11px] font-medium uppercase tracking-[0.18em] text-zinc-500">
          Use your email or passkey
        </p>
        <section
          ref={authSectionRef}
          aria-label="Email, passkey, and wallet sign-in"
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
        </section>
        <section aria-label="Continue with wallet" className="mt-4 space-y-2">
          <p className="text-[11px] font-medium uppercase tracking-[0.18em] text-zinc-500">
            Continue with wallet
          </p>
          <button
            type="button"
            onClick={() => {
              triggerEmbeddedAuthAction("wallet-auth-button");
            }}
            className="flex w-full items-center justify-center rounded-lg border border-zinc-700 bg-zinc-950/60 px-4 py-2.5 text-sm font-medium text-zinc-100 transition-colors hover:border-zinc-500 hover:bg-zinc-900"
          >
            Continue with wallet
          </button>
        </section>
      </div>
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
