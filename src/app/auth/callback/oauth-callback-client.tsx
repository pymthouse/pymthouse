"use client";

import {
  AuthState,
  ClientState,
  useTurnkey,
} from "@turnkey/react-wallet-kit";
import { useSession } from "next-auth/react";
import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import {
  bridgeTurnkeySessionToNextAuth,
  safeCallbackUrl,
} from "@/lib/turnkey-nextauth-bridge";
import { takeTurnkeyOauthRedirectOnce } from "@/lib/turnkey-oauth-redirect";

/**
 * OAuth return surface for Turnkey Wallet Kit social logins.
 * Google/Discord use a same-tab redirect (not a popup) so Chrome cannot
 * block the start. Bridges NextAuth only when this tab started OAuth
 * (pending resume token in sessionStorage).
 */
export function OAuthCallbackClient() {
  const {
    authState,
    clientState,
    getSession,
    refreshWallets,
    refreshUser,
    user,
    wallets,
  } = useTurnkey();
  const { status: nextAuthStatus } = useSession();
  const router = useRouter();
  const searchParams = useSearchParams();
  const storedRedirect = useRef(takeTurnkeyOauthRedirectOnce());
  const callbackUrl = safeCallbackUrl(
    searchParams.get("callbackUrl") || storedRedirect.current?.callbackUrl,
  );
  const providerError = searchParams.get("error");

  const [error, setError] = useState<string | null>(null);
  const bridging = useRef(false);

  useEffect(() => {
    if (nextAuthStatus === "authenticated") {
      router.replace(callbackUrl);
    }
  }, [nextAuthStatus, router, callbackUrl]);

  useEffect(() => {
    if (bridging.current) return;
    if (providerError) return;
    if (nextAuthStatus !== "unauthenticated") return;
    if (authState !== AuthState.Authenticated) return;
    if (clientState !== ClientState.Ready) return;
    // Only bridge a Turnkey session from this tab's OAuth start (resume CSRF
    // in sessionStorage). A leftover wallet session on a cold /auth/callback
    // visit must not mint NextAuth.
    if (!storedRedirect.current) {
      router.replace("/login");
      return;
    }

    bridging.current = true;

    (async () => {
      try {
        const result = await bridgeTurnkeySessionToNextAuth({
          getSession: () => getSession(),
          refreshUser,
          refreshWallets,
          wallets,
          user,
        });
        if (result.ok) {
          router.replace(callbackUrl);
          return;
        }
        setError(result.error);
        bridging.current = false;
      } catch (err) {
        setError(err instanceof Error ? err.message : "Authentication failed");
        bridging.current = false;
      }
    })().catch(() => {
      bridging.current = false;
    });
  }, [
    authState,
    clientState,
    nextAuthStatus,
    providerError,
    getSession,
    refreshUser,
    refreshWallets,
    wallets,
    user,
    router,
    callbackUrl,
  ]);

  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-zinc-950 px-6">
      <p className="text-2xl font-bold tracking-tight mb-6">
        <span className="text-emerald-400">pymt</span>house
      </p>
      {error || providerError ? (
        <div className="w-full max-w-sm space-y-3 text-center">
          <p className="text-sm text-red-400 bg-red-500/10 border border-red-500/20 rounded-lg px-3 py-2">
            {error ||
              (providerError === "access_denied"
                ? "Sign-in was canceled. You can try again or use a different method."
                : "Sign-in failed. Please try again.")}
          </p>
          <a
            href="/login"
            className="inline-block text-sm text-zinc-400 hover:text-zinc-200 transition-colors"
          >
            Back to sign in
          </a>
        </div>
      ) : (
        <p className="text-sm text-zinc-400 animate-pulse">
          Completing sign-in…
        </p>
      )}
    </div>
  );
}
