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
const AUTH_BUTTON_CLASS =
  "flex w-full items-center justify-center gap-2 rounded-lg border border-zinc-700 bg-zinc-950/60 px-4 py-2.5 text-sm font-medium leading-5 text-zinc-100 transition-colors hover:border-zinc-500 hover:bg-zinc-900";

function GoogleMark({ className }: Readonly<{ className?: string }>) {
  return (
    <svg className={className} viewBox="0 0 24 24" aria-hidden>
      <path
        fill="#4285F4"
        d="M23.49 12.27c0-.79-.07-1.55-.2-2.27H12v4.29h6.45a5.52 5.52 0 0 1-2.4 3.62v3h3.88c2.28-2.1 3.56-5.19 3.56-8.64Z"
      />
      <path
        fill="#34A853"
        d="M12 24c3.24 0 5.95-1.07 7.93-2.91l-3.88-3c-1.08.73-2.46 1.16-4.05 1.16-3.12 0-5.76-2.1-6.7-4.93H1.3v3.1A12 12 0 0 0 12 24Z"
      />
      <path
        fill="#FBBC05"
        d="M5.3 14.32A7.2 7.2 0 0 1 4.93 12c0-.8.14-1.57.37-2.32v-3.1H1.3A12 12 0 0 0 0 12c0 1.93.46 3.76 1.3 5.42l4-3.1Z"
      />
      <path
        fill="#EA4335"
        d="M12 4.77c1.76 0 3.33.61 4.57 1.8l3.43-3.43C17.94 1.19 15.23 0 12 0A12 12 0 0 0 1.3 6.58l4 3.1C6.23 6.87 8.88 4.77 12 4.77Z"
      />
    </svg>
  );
}

function DiscordMark({ className }: Readonly<{ className?: string }>) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="currentColor" aria-hidden>
      <path d="M20.32 4.37a19.8 19.8 0 0 0-4.9-1.52.07.07 0 0 0-.07.04l-.62 1.11a18.2 18.2 0 0 0-5.46 0l-.63-1.1a.07.07 0 0 0-.07-.05c-1.7.28-3.35.8-4.9 1.52a.06.06 0 0 0-.03.02C.53 9.08-.2 13.66.16 18.17c0 .03.02.05.04.07 2 1.48 3.95 2.38 5.87 2.98a.07.07 0 0 0 .08-.02l1.2-1.65c-1.28-.48-2.5-1.1-3.66-1.9a.07.07 0 0 1-.01-.12c.24-.18.49-.36.72-.55a.07.07 0 0 1 .08-.01c7.66 3.5 15.97 3.5 23.54 0a.07.07 0 0 1 .08.01l.72.55a.07.07 0 0 1-.01.12c-1.16.8-2.38 1.42-3.66 1.9l1.2 1.65a.07.07 0 0 0 .08.02c1.93-.6 3.88-1.5 5.87-2.98a.07.07 0 0 0 .04-.07c.43-5.2-.72-9.74-3.42-13.78a.06.06 0 0 0-.03-.02ZM8.28 15.4c-1.45 0-2.64-1.34-2.64-2.98 0-1.64 1.17-2.98 2.64-2.98 1.48 0 2.66 1.35 2.64 2.98 0 1.64-1.17 2.98-2.64 2.98Zm7.44 0c-1.45 0-2.64-1.34-2.64-2.98 0-1.64 1.17-2.98 2.64-2.98 1.48 0 2.66 1.35 2.64 2.98 0 1.64-1.16 2.98-2.64 2.98Z" />
    </svg>
  );
}

export function TurnkeyEmbeddedAuth({
  primaryColor = "#10b981",
  logoUrl,
  title = "Sign in or create your account",
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
  const [hasGoogleOAuthAction, setHasGoogleOAuthAction] = useState(false);
  const [hasDiscordOAuthAction, setHasDiscordOAuthAction] = useState(false);
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
      // Search the whole auth section — OAuth buttons may not live in the first
      // `div.w-full` if Turnkey's methodOrder puts email/passkey/wallet first.
      const section = authSectionRef.current;
      if (!section) return;

      const googleButton = section.querySelector(
        "button[data-testid='oauth-google']",
      ) as HTMLButtonElement | null;
      const discordButton = section.querySelector(
        "button[data-testid='oauth-discord']",
      ) as HTMLButtonElement | null;
      setHasGoogleOAuthAction((prev) => {
        const next = !!googleButton;
        return prev === next ? prev : next;
      });
      setHasDiscordOAuthAction((prev) => {
        const next = !!discordButton;
        return prev === next ? prev : next;
      });

      const googleGroup = googleButton?.closest("div.w-full") as HTMLElement | null;
      if (googleGroup) googleGroup.style.display = "none";
      const discordGroup = discordButton?.closest("div.w-full") as HTMLElement | null;
      if (discordGroup) discordGroup.style.display = "none";

      // Hide kit "OR" dividers between methods; keep the Terms/Privacy footer.
      section
        .querySelectorAll(
          "div.flex.flex-row.w-full.items-center.justify-center.my-4",
        )
        .forEach((divider) => {
          (divider as HTMLElement).style.display = "none";
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
        is blocked by TurnkeyModalDismissGuard. Keep the kit Terms/Privacy
        footer (stacked last via CSS order); hide only kit OAuth chrome and
        OR dividers that we replace with custom social buttons.
      */}
      <div
        className={
          "dark tk-embedded-auth w-full overflow-hidden rounded-lg [&_.w-96]:!w-full [&_button[data-testid='oauth-google']]:hidden [&_button[data-testid='oauth-discord']]:hidden [&_div.flex.flex-row.w-full.items-center.justify-center.my-4]:hidden" +
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
        <section aria-label="Continue with" className="mb-4 space-y-2">
          <p className="text-[11px] font-medium uppercase tracking-[0.18em] text-zinc-500">
            Continue with
          </p>
          {hasGoogleOAuthAction && (
            <button
              type="button"
              onClick={() => {
                triggerEmbeddedAuthAction("oauth-google");
              }}
              className={AUTH_BUTTON_CLASS}
            >
              <GoogleMark className="h-4 w-4" />
              Continue with Google
            </button>
          )}
          <GitHubTurnkeyLoginButton
            primaryColor={primaryColor}
            sectionLabel={null}
            containerClassName="space-y-2"
          />
          {hasDiscordOAuthAction && (
            <button
              type="button"
              onClick={() => {
                triggerEmbeddedAuthAction("oauth-discord");
              }}
              className={AUTH_BUTTON_CLASS}
            >
              <DiscordMark className="h-4 w-4" />
              Continue with Discord
            </button>
          )}
        </section>
        <p className="mb-2 text-[11px] font-medium uppercase tracking-[0.18em] text-zinc-500">
          Or continue with
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
