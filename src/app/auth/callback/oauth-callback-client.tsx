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

/**
 * Minimal OAuth return surface for Turnkey.
 * Does NOT clear leftover Turnkey sessions (that would race the OAuth return).
 * Popup flows may briefly paint this before the parent closes the window;
 * full-page redirects (mobile) complete the NextAuth bridge here.
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
  const callbackUrl = safeCallbackUrl(searchParams.get("callbackUrl"));

  const [error, setError] = useState<string | null>(null);
  const bridging = useRef(false);

  useEffect(() => {
    if (nextAuthStatus === "authenticated") {
      router.replace(callbackUrl);
    }
  }, [nextAuthStatus, router, callbackUrl]);

  useEffect(() => {
    if (bridging.current) return;
    if (nextAuthStatus !== "unauthenticated") return;
    if (authState !== AuthState.Authenticated) return;
    if (clientState !== ClientState.Ready) return;

    bridging.current = true;
    setError(null);

    void (async () => {
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
    })();
  }, [
    authState,
    clientState,
    nextAuthStatus,
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
      {error ? (
        <div className="w-full max-w-sm space-y-3 text-center">
          <p className="text-sm text-red-400 bg-red-500/10 border border-red-500/20 rounded-lg px-3 py-2">
            {error}
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
