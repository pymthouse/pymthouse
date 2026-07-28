"use client";

import {
  AuthState,
  ClientState,
  useTurnkey,
} from "@turnkey/react-wallet-kit";
import { useSession } from "next-auth/react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useState } from "react";
import { MarketingFooter } from "@/components/MarketingFooter";
import { TurnkeyEmbeddedAuth } from "@/components/TurnkeyEmbeddedAuth";
import { toSafeLogoUrl } from "@/lib/safe-logo-url";
import { safeCallbackUrl } from "@/lib/turnkey-nextauth-bridge";

interface AppBranding {
  mode: "blackLabel" | "whiteLabel";
  displayName: string;
  logoUrl: string | null;
  primaryColor: string;
}

function authErrorMessage(authError: string | null): string | null {
  if (!authError) return null;
  if (authError.includes("AccessDenied")) {
    return "Sign-in was denied. You can try again or use a different sign-in method.";
  }
  return "Sign-in failed. Please try again.";
}

/** Full-screen placeholder text while redirecting or resolving the session. */
function splashMessage(isAdmin: boolean, status: string): string | null {
  if (isAdmin || status === "authenticated") return "Redirecting...";
  if (status === "loading") return "Loading...";
  return null;
}

/**
 * Green CTA only after sign-in UI is idle: session settled, Turnkey ready,
 * user not mid-bridge/redirect, and (when relevant) branding resolved.
 */
function shouldShowStartCta(input: {
  status: string;
  brandingResolved: boolean;
  clientState: ClientState | undefined;
  authState: AuthState | undefined;
  isOidcFlow: boolean;
  isWhiteLabel: boolean;
  resumePersona: "explorer" | "builder" | null;
}): boolean {
  const turnkeyConfigured =
    !!process.env.NEXT_PUBLIC_ORGANIZATION_ID?.trim() &&
    !!process.env.NEXT_PUBLIC_AUTH_PROXY_CONFIG_ID?.trim();
  const loginUiReady =
    input.status === "unauthenticated" &&
    input.brandingResolved &&
    (!turnkeyConfigured ||
      (input.clientState === ClientState.Ready &&
        input.authState === AuthState.Unauthenticated));
  return (
    loginUiReady &&
    !input.isOidcFlow &&
    !input.isWhiteLabel &&
    !input.resumePersona
  );
}

/** Tenant branding for OIDC sign-in; resolves immediately when not needed. */
function useAppBranding(clientId: string | null, needsBranding: boolean) {
  const [branding, setBranding] = useState<AppBranding | null>(null);
  const [brandingResolved, setBrandingResolved] = useState(!needsBranding);

  useEffect(() => {
    if (!clientId || !needsBranding) {
      setBrandingResolved(true);
      return;
    }
    let cancelled = false;
    setBrandingResolved(false);
    fetch(`/api/v1/apps/branding?client_id=${encodeURIComponent(clientId)}`)
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (!cancelled && data?.branding) {
          setBranding(data.branding);
        }
      })
      .catch(() => {})
      .finally(() => {
        if (!cancelled) setBrandingResolved(true);
      });
    return () => {
      cancelled = true;
    };
  }, [clientId, needsBranding]);

  return { branding, brandingResolved };
}

function LoginPathQuote({
  quote,
  className,
}: Readonly<{
  quote: { text: string; attribution: string };
  className?: string;
}>) {
  return (
    <blockquote className={className}>
      <p className="text-sm italic leading-relaxed text-zinc-400">
        &ldquo;{quote.text}&rdquo;
      </p>
      <footer className="mt-2 text-xs font-medium tracking-wide text-emerald-400/80">
        — {quote.attribution}
      </footer>
    </blockquote>
  );
}

function LoginBrandHeader({
  branding,
  logoUrl,
  alignWide,
}: Readonly<{
  branding: AppBranding | null;
  logoUrl: string | null;
  alignWide: boolean;
}>) {
  const isWhiteLabel = branding?.mode === "whiteLabel";
  return (
    <div className={`mb-8 ${alignWide ? "text-center lg:text-left" : "text-center"}`}>
      {isWhiteLabel && branding ? (
        <>
          {logoUrl ? (
            // Tenant logo URLs are dynamic, so next/image remote host config cannot enumerate them.
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={logoUrl}
              alt={branding.displayName}
              className="mx-auto mb-4 h-12 w-auto"
            />
          ) : null}
          <h1 className="text-3xl font-bold tracking-tight text-zinc-100">
            {branding.displayName}
          </h1>
          <p className="text-zinc-500 mt-2 text-sm">Log in or sign up</p>
        </>
      ) : (
        <>
          <h1 className="text-3xl font-bold tracking-tight">
            <Link
              href="/"
              className="inline-block hover:opacity-90 transition-opacity"
            >
              <span className="text-emerald-400">pymt</span>house
            </Link>
          </h1>
          <p className="text-zinc-500 mt-2 text-sm">Log in or sign up</p>
        </>
      )}
    </div>
  );
}

function LoginStartCtaPanel({
  pathQuote,
}: Readonly<{
  pathQuote: { text: string; attribution: string };
}>) {
  return (
    <div className="order-2 flex flex-col rounded-xl border border-teal-500/40 bg-gradient-to-br from-teal-500/15 via-teal-500/5 to-transparent p-6 sm:p-8 lg:order-1">
      <div className="flex flex-1 flex-col justify-center">
        <p className="text-xs font-mono uppercase tracking-[0.2em] text-teal-400/90">
          New here?
        </p>
        <p className="mt-2 text-xl font-semibold text-zinc-50 sm:text-2xl">
          Explore and Build
        </p>
        <p className="mt-2 max-w-md text-sm leading-relaxed text-zinc-300 sm:text-base">
          Explore the Livepeer network and build your own AI platform!
        </p>
        <Link
          href="/start"
          className="mt-5 inline-flex w-full items-center justify-center gap-2 rounded-lg border border-teal-400/60 bg-teal-500/20 px-5 py-3 text-sm font-semibold text-teal-100 transition-colors hover:bg-teal-500/30 hover:text-white focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-teal-400/50 sm:w-auto sm:self-start"
        >
          Create an account
          <svg
            className="h-4 w-4"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
            aria-hidden
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={1.75}
              d="M13 7l5 5m0 0l-5 5m5-5H6"
            />
          </svg>
        </Link>
      </div>
      <LoginPathQuote
        quote={pathQuote}
        className="ml-auto max-w-sm border-r-2 border-emerald-500/50 pt-4 pr-4 text-right"
      />
    </div>
  );
}

function LoginPageFooter({
  isWhiteLabel,
  showStartCta,
  pathQuote,
}: Readonly<{
  isWhiteLabel: boolean;
  showStartCta: boolean;
  pathQuote: { text: string; attribution: string };
}>) {
  if (isWhiteLabel) {
    return (
      <footer className="relative z-10 px-4 py-6 text-center sm:px-6">
        <p className="text-xs text-zinc-600">
          Identity powered by{" "}
          <span className="text-zinc-500">
            <span className="text-emerald-500">pymt</span>house
          </span>
        </p>
      </footer>
    );
  }

  return (
    <div className="relative z-10 mx-auto w-full max-w-4xl px-4 pb-8 pt-4 sm:px-6">
      {!showStartCta && (
        <LoginPathQuote
          quote={pathQuote}
          className="mb-8 ml-auto max-w-md border-r-2 border-emerald-500/50 pr-4 text-right"
        />
      )}
      <MarketingFooter />
    </div>
  );
}

export function LoginForm() {
  const { data: session, status } = useSession();
  const { clientState, authState } = useTurnkey();
  const router = useRouter();
  const searchParams = useSearchParams();
  const callbackUrl = searchParams.get("callbackUrl") || "/onboarding";
  const sanitizedCallbackUrl = safeCallbackUrl(callbackUrl, "/onboarding");
  const clientId = searchParams.get("client_id");
  const isAdmin = searchParams.get("admin") === "1";
  const isOidcFlow = sanitizedCallbackUrl.includes("/oidc/");
  const needsBranding = !!(clientId && isOidcFlow);
  const { branding, brandingResolved } = useAppBranding(clientId, needsBranding);
  /** Resume path from public /start (Explorer | Builder). Plain /login has none. */
  const resumePersona = personaFromCallback(sanitizedCallbackUrl);
  const oauthCallbackMessage = authErrorMessage(searchParams.get("error"));

  // Preserve legacy ?admin=1 links by sending them to the dedicated admin login.
  useEffect(() => {
    if (!isAdmin) return;
    const params = new URLSearchParams(searchParams.toString());
    params.delete("admin");
    const qs = params.toString();
    router.replace(qs ? `/login/admin?${qs}` : "/login/admin");
  }, [isAdmin, router, searchParams]);

  const isWhiteLabel = branding?.mode === "whiteLabel";
  const primaryColor = branding?.primaryColor || "#10b981";
  const logoUrl = toSafeLogoUrl(branding?.logoUrl ?? null);
  /** Path-specific quote from a secular business leader; main login uses a default. */
  const pathQuote = LOGIN_QUOTES[resumePersona ?? "default"];

  useEffect(() => {
    if (status === "authenticated" && session) {
      router.push(sanitizedCallbackUrl);
    }
  }, [session, status, router, sanitizedCallbackUrl]);

  const splash = splashMessage(isAdmin, status);
  if (splash) {
    return (
      <div className="flex items-center justify-center min-h-screen bg-zinc-950">
        <div className="animate-pulse text-zinc-500">{splash}</div>
      </div>
    );
  }

  const showStartCta = shouldShowStartCta({
    status,
    brandingResolved,
    clientState,
    authState,
    isOidcFlow,
    isWhiteLabel: !!isWhiteLabel,
    resumePersona,
  });

  return (
    <div className="relative flex min-h-screen flex-col overflow-x-hidden bg-zinc-950">
      {!isWhiteLabel && (
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0 bg-[radial-gradient(ellipse_70%_45%_at_50%_-5%,rgba(16,185,129,0.12),transparent_55%)]"
        />
      )}

      <main className="relative z-10 flex flex-1 flex-col items-center justify-center px-4 py-10 sm:px-6">
        <div
          className={`w-full ${showStartCta ? "max-w-4xl" : "max-w-sm"}`}
        >
          {/*
            Hero wordmark above the panel (HTML text, not kit SVG-as-img).
            Kit AuthComponent hard-caps logo at max-w-32 / max-h-16 — too small,
            and Firefox can collapse the SVG <img> to an invisible/tiny box.
            Brand outside the kit; pass logoUrl={null} so AuthComponent has no interior logo.
          */}
          <LoginBrandHeader
            branding={branding}
            logoUrl={logoUrl}
            alignWide={showStartCta}
          />

          <div
            className={
              showStartCta
                ? "grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,22rem)] lg:items-stretch lg:gap-8"
                : undefined
            }
          >
            {showStartCta ? <LoginStartCtaPanel pathQuote={pathQuote} /> : null}

            <div className="order-1 mx-auto w-full max-w-sm lg:order-2 lg:mx-0 lg:justify-self-end">
              <div className="rounded-xl border border-zinc-800 bg-zinc-900/30 p-6">
                <TurnkeyEmbeddedAuth
                  primaryColor={primaryColor}
                  logoUrl={null}
                  title="Log in or sign up"
                />
                {oauthCallbackMessage ? (
                  <p className="mt-4 rounded-lg border border-amber-500/25 bg-amber-500/10 px-3 py-2 text-xs text-amber-300/90">
                    {oauthCallbackMessage}
                  </p>
                ) : null}
              </div>
            </div>
          </div>
        </div>
      </main>

      <LoginPageFooter
        isWhiteLabel={!!isWhiteLabel}
        showStartCta={showStartCta}
        pathQuote={pathQuote}
      />
    </div>
  );
}

const LOGIN_QUOTES = {
  explorer: {
    text: "Failure is an option here. If things are not failing, you are not innovating enough.",
    attribution: "Elon Musk",
  },
  builder: {
    text: "Make something people want.",
    attribution: "Paul Graham",
  },
  default: {
    text: "Make something people want.",
    attribution: "Paul Graham",
  },
} as const;

function personaFromCallback(
  callback: string,
): "explorer" | "builder" | null {
  try {
    const persona = new URL(callback, "https://pymthouse.local").searchParams.get(
      "persona",
    );
    if (persona === "explorer" || persona === "builder") return persona;
  } catch {
    /* ignore */
  }
  return null;
}
