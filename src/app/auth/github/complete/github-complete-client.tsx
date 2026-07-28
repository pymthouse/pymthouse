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
 * Share one handoff fetch across React Strict Mode remounts. The cookie is
 * one-shot; a second mount must reuse the in-flight result instead of POSTing
 * again and getting 404 before storeSession finishes.
 */
let githubHandoffPromise: Promise<string | null> | null = null;

function consumeGithubHandoffSession(): Promise<string | null> {
  if (!githubHandoffPromise) {
    githubHandoffPromise = (async () => {
      const res = await fetch("/api/auth/github/session", { method: "POST" });
      if (!res.ok) return null;
      const data = (await res.json()) as { sessionToken?: string };
      return data.sessionToken ?? null;
    })().catch(() => null);
  }
  return githubHandoffPromise;
}

/**
 * Completes GitHub → Turnkey login: load handoff session, store in Wallet Kit,
 * then bridge to NextAuth (same path as Google/OTP/passkey).
 */
export function GitHubCompleteClient() {
  const {
    storeSession,
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
  const [sessionReady, setSessionReady] = useState(false);
  const handoffStarted = useRef(false);
  const bridging = useRef(false);

  useEffect(() => {
    if (nextAuthStatus === "authenticated") {
      router.replace(callbackUrl);
    }
  }, [nextAuthStatus, router, callbackUrl]);

  // Prefer the one-shot handoff cookie so we never bridge a stale Turnkey session.
  useEffect(() => {
    if (handoffStarted.current) return;
    if (clientState !== ClientState.Ready) return;

    handoffStarted.current = true;
    (async () => {
      try {
        const sessionToken = await consumeGithubHandoffSession();
        if (sessionToken) {
          await storeSession({ sessionToken });
          setSessionReady(true);
          return;
        }
        // Handoff already consumed (e.g. Strict Mode remount) — use live session.
        if (authState === AuthState.Authenticated) {
          setSessionReady(true);
          return;
        }
        throw new Error("Missing GitHub Turnkey session");
      } catch (err) {
        setError(
          err instanceof Error ? err.message : "Failed to restore session",
        );
        handoffStarted.current = false;
      }
    })().catch(() => {
      handoffStarted.current = false;
    });
  }, [authState, clientState, storeSession]);

  // Same NextAuth bridge as /auth/callback and embedded OTP/social.
  useEffect(() => {
    if (!sessionReady) return;
    if (bridging.current) return;
    if (nextAuthStatus !== "unauthenticated") return;
    if (authState !== AuthState.Authenticated) return;
    if (clientState !== ClientState.Ready) return;

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
    sessionReady,
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
      <p className="mb-6 text-2xl font-bold tracking-tight">
        <span className="text-emerald-400">pymt</span>house
      </p>
      {error ? (
        <div className="w-full max-w-sm space-y-3 text-center">
          <p className="rounded-lg border border-red-500/20 bg-red-500/10 px-3 py-2 text-sm text-red-400">
            {error}
          </p>
          <a
            href="/login"
            className="inline-block text-sm text-zinc-400 transition-colors hover:text-zinc-200"
          >
            Back to sign in
          </a>
        </div>
      ) : (
        <p className="animate-pulse text-sm text-zinc-400">
          Completing GitHub sign-in…
        </p>
      )}
    </div>
  );
}
