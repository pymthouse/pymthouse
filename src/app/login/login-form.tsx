"use client";

import { sanitizeUrl } from "@braintree/sanitize-url";
import { useSession } from "next-auth/react";
import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useState } from "react";
import { MarketingFooter } from "@/components/MarketingFooter";
import { TurnkeyEmbeddedAuth } from "@/components/TurnkeyEmbeddedAuth";

interface AppBranding {
  mode: "blackLabel" | "whiteLabel";
  displayName: string;
  logoUrl: string | null;
  primaryColor: string;
}

export function LoginForm() {
  const { data: session, status } = useSession();
  const router = useRouter();
  const searchParams = useSearchParams();
  const [branding, setBranding] = useState<AppBranding | null>(null);
  const callbackUrl = searchParams.get("callbackUrl") || "/apps";
  const safeCallbackUrl =
    callbackUrl.startsWith("/") && !callbackUrl.startsWith("//")
      ? callbackUrl
      : "/apps";
  const clientId = searchParams.get("client_id");
  const isAdmin = searchParams.get("admin") === "1";
  const isOidcFlow = callbackUrl.includes("/oidc/");
  const authError = searchParams.get("error");
  const accessDenied =
    authError === "AccessDenied" ||
    (typeof authError === "string" && authError.includes("AccessDenied"));
  const oauthCallbackMessage = accessDenied
    ? "Sign-in was denied. You can try again or use a different sign-in method."
    : authError
      ? "Sign-in failed. Please try again."
      : null;

  // Preserve legacy ?admin=1 links by sending them to the dedicated admin login.
  useEffect(() => {
    if (!isAdmin) return;
    const params = new URLSearchParams(searchParams.toString());
    params.delete("admin");
    const qs = params.toString();
    router.replace(qs ? `/login/admin?${qs}` : "/login/admin");
  }, [isAdmin, router, searchParams]);

  useEffect(() => {
    if (clientId && isOidcFlow) {
      fetch(`/api/v1/apps/branding?client_id=${encodeURIComponent(clientId)}`)
        .then((res) => (res.ok ? res.json() : null))
        .then((data) => {
          if (data?.branding) {
            setBranding(data.branding);
          }
        })
        .catch(() => {});
    }
  }, [clientId, isOidcFlow]);

  const isWhiteLabel = branding?.mode === "whiteLabel";
  const primaryColor = branding?.primaryColor || "#10b981";
  const logoUrl = toSafeLogoUrl(branding?.logoUrl ?? null);
  // Always brand outside the kit. AuthComponent logos are capped at max-w-32 /
  // max-h-16 and Firefox often collapses the SVG <img> to a near-invisible box.
  // Brand outside the kit (AuthComponent only shows its title when a logo is set).
  const authLogoUrl = null;
  const authTitle = "Log in or sign up";

  useEffect(() => {
    if (status === "authenticated" && session) {
      router.push(safeCallbackUrl);
    }
  }, [session, status, router, safeCallbackUrl]);

  if (isAdmin) {
    return (
      <div className="flex items-center justify-center min-h-screen bg-zinc-950">
        <div className="animate-pulse text-zinc-500">Redirecting...</div>
      </div>
    );
  }

  if (status === "authenticated") {
    return (
      <div className="flex items-center justify-center min-h-screen bg-zinc-950">
        <div className="animate-pulse text-zinc-500">Redirecting...</div>
      </div>
    );
  }

  if (status === "loading") {
    return (
      <div className="flex items-center justify-center min-h-screen bg-zinc-950">
        <div className="animate-pulse text-zinc-500">Loading...</div>
      </div>
    );
  }

  return (
    <div className="flex items-center justify-center min-h-screen bg-zinc-950">
      <div className="w-full max-w-sm">
        {/*
          Hero wordmark above the panel (HTML text, not kit SVG-as-img).
          Kit AuthComponent hard-caps logo at max-w-32 / max-h-16 — too small,
          and Firefox can collapse the SVG <img> to an invisible/tiny box.
        */}
        <div className="text-center mb-8">
          {isWhiteLabel && branding ? (
            <>
              {logoUrl && (
                // Tenant logo URLs are dynamic, so next/image remote host config cannot enumerate them.
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={logoUrl}
                  alt={branding.displayName}
                  className="h-12 w-auto mx-auto mb-4"
                />
              )}
              <h1 className="text-3xl font-bold tracking-tight text-zinc-100">
                {branding.displayName}
              </h1>
              <p className="text-zinc-500 mt-2 text-sm">Log in or sign up</p>
            </>
          ) : (
            <>
              <h1 className="text-3xl font-bold tracking-tight">
                <span className="text-emerald-400">pymt</span>house
              </h1>
              <p className="text-zinc-500 mt-2 text-sm">Log in or sign up</p>
            </>
          )}
        </div>

        <div className="border border-zinc-800 rounded-xl p-6 bg-zinc-900/30 mb-4">
          <TurnkeyEmbeddedAuth
            primaryColor={primaryColor}
            logoUrl={authLogoUrl}
            title={authTitle}
          />
          {oauthCallbackMessage && (
            <p className="text-xs text-amber-300/90 bg-amber-500/10 border border-amber-500/25 rounded-lg px-3 py-2 mt-4">
              {oauthCallbackMessage}
            </p>
          )}
        </div>

        {isWhiteLabel ? (
          <footer className="mt-6 pt-4 text-center">
            <p className="text-xs text-zinc-600">
              Identity powered by{" "}
              <span className="text-zinc-500">
                <span className="text-emerald-500">pymt</span>house
              </span>
            </p>
          </footer>
        ) : (
          <MarketingFooter className="mt-6" />
        )}
      </div>
    </div>
  );
}

/** Returns a sanitized URL, or null for anything unsafe. */
function toSafeLogoUrl(url: string | null): string | null {
  if (!url) return null;
  const trimmed = url.trim();
  if (!trimmed) return null;
  if (trimmed.startsWith("//")) return null;
  const safe = sanitizeUrl(trimmed);
  return safe === "about:blank" ? null : safe;
}
