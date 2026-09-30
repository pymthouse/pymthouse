"use client";

import { AuthState, ClientState, useTurnkey } from "@turnkey/react-wallet-kit";
import { useSession } from "next-auth/react";
import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import {
  bridgeTurnkeySessionToNextAuth,
  safeCallbackUrl,
} from "@/lib/turnkey-nextauth-bridge";
import { TURNKEY_WALLET_PROVIDER_NAME } from "@/lib/turnkey-wallet-oidc";

type Attach = {
  organizationId: string;
  turnkeyUserId: string;
  registrationToken: string;
};

type Handoff = {
  sessionToken: string;
  attach: Attach | null;
};

let handoffPromise: Promise<Handoff | null> | null = null;

function consumeHandoff(): Promise<Handoff | null> {
  handoffPromise ??= (async () => {
    const res = await fetch("/api/auth/wallet/session", { method: "POST" });
    if (!res.ok) return null;
    const data = (await res.json()) as {
      sessionToken?: string;
      attach?: Attach | null;
    };
    if (!data.sessionToken) return null;
    return { sessionToken: data.sessionToken, attach: data.attach ?? null };
  })().catch(() => null);
  return handoffPromise;
}

export function WalletCompleteClient() {
  const {
    storeSession,
    authState,
    clientState,
    getSession,
    refreshWallets,
    refreshUser,
    user,
    wallets,
    httpClient,
  } = useTurnkey();
  const { status: nextAuthStatus } = useSession();
  const router = useRouter();
  const searchParams = useSearchParams();
  const callbackUrl = safeCallbackUrl(searchParams.get("callbackUrl"));
  const [error, setError] = useState<string | null>(null);
  const [sessionReady, setSessionReady] = useState(false);
  const attachRef = useRef<Attach | null>(null);
  const handoffStarted = useRef(false);
  const bridging = useRef(false);

  useEffect(() => {
    if (nextAuthStatus === "authenticated") router.replace(callbackUrl);
  }, [nextAuthStatus, router, callbackUrl]);

  useEffect(() => {
    if (handoffStarted.current || clientState !== ClientState.Ready) return;
    handoffStarted.current = true;
    void (async () => {
      try {
        const handoff = await consumeHandoff();
        if (!handoff) {
          if (authState === AuthState.Authenticated) setSessionReady(true);
          else setError("Sign-in expired. Please try again.");
          return;
        }
        attachRef.current = handoff.attach;
        await storeSession({ sessionToken: handoff.sessionToken });
        setSessionReady(true);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Could not finish sign-in");
      }
    })();
  }, [authState, clientState, storeSession]);

  useEffect(() => {
    if (!sessionReady || authState !== AuthState.Authenticated || bridging.current) return;
    if (nextAuthStatus === "loading" || nextAuthStatus === "authenticated") return;
    bridging.current = true;
    void (async () => {
      const attach = attachRef.current;
      if (attach && httpClient) {
        try {
          await httpClient.createOauthProviders({
            organizationId: attach.organizationId,
            userId: attach.turnkeyUserId,
            oauthProviders: [
              {
                providerName: TURNKEY_WALLET_PROVIDER_NAME,
                oidcToken: attach.registrationToken,
              },
            ],
          });
        } catch (err) {
          console.error("wallet issuer attach failed", err);
        }
      }
      const bridged = await bridgeTurnkeySessionToNextAuth({
        getSession,
        refreshUser,
        refreshWallets,
        wallets,
        user,
      });
      if (!bridged.ok) {
        setError(bridged.error);
        bridging.current = false;
        return;
      }
      router.replace(callbackUrl);
    })();
  }, [
    sessionReady,
    authState,
    nextAuthStatus,
    httpClient,
    getSession,
    refreshUser,
    refreshWallets,
    wallets,
    user,
    router,
    callbackUrl,
  ]);

  return (
    <div className="flex min-h-screen items-center justify-center bg-zinc-950 px-4">
      <p className="text-sm text-zinc-400">
        {error ?? "Signing you in…"}
      </p>
    </div>
  );
}
