"use client";

import {
  AuthState,
  ClientState,
  useTurnkey,
} from "@turnkey/react-wallet-kit";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";

function firstEvmAddress(
  wallets: { accounts: { address: string }[] }[],
): string | undefined {
  for (const w of wallets) {
    for (const a of w.accounts) {
      if (typeof a.address === "string" && a.address.startsWith("0x")) {
        return a.address;
      }
    }
  }
  return undefined;
}

export function WalletSetupClient({ destination }: { destination: string }) {
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

  return <WalletSetupInner destination={destination} />;
}

function WalletSetupInner({ destination }: { destination: string }) {
  const {
    handleLogin,
    authState,
    clientState,
    getSession,
    refreshWallets,
    refreshUser,
    wallets,
  } = useTurnkey();
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [linking, setLinking] = useState(false);
  const [linkRequested, setLinkRequested] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (
      !linkRequested ||
      authState !== AuthState.Authenticated ||
      clientState !== ClientState.Ready ||
      linking
    ) {
      return;
    }

    (async () => {
      setLinking(true);
      setError(null);
      try {
        await refreshUser();
        await refreshWallets();
        const session = await getSession();
        if (!session?.token) {
          setError("Could not get Turnkey session token.");
          setLinking(false);
          setLinkRequested(false);
          return;
        }
        const walletAddress = firstEvmAddress(wallets);
        const res = await fetch("/api/v1/account/link-wallet", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            turnkeySessionJwt: session.token,
            walletAddress: walletAddress ?? "",
          }),
        });
        if (!res.ok) {
          const data = (await res.json()) as { error?: string };
          setError(data.error ?? "Failed to link wallet.");
          setLinking(false);
          setLinkRequested(false);
          return;
        }
        router.push(destination);
      } catch {
        setError("Failed to link wallet.");
        setLinking(false);
        setLinkRequested(false);
      }
    })();
  }, [
    linkRequested,
    authState,
    clientState,
    linking,
    getSession,
    refreshUser,
    refreshWallets,
    wallets,
    router,
    destination,
  ]);

  return (
    <div>
      <button
        type="button"
        onClick={() => {
          setError(null);
          void (async () => {
            setPending(true);
            try {
              await handleLogin();
              setLinkRequested(true);
            } catch {
              setError("Authentication failed.");
            } finally {
              setPending(false);
            }
          })();
        }}
        disabled={pending || linking || clientState === ClientState.Loading}
        className="w-full px-4 py-3 bg-emerald-500 text-white rounded-lg text-sm font-medium hover:opacity-90 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
      >
        {pending || linking ? "Connecting..." : "Create Wallet"}
      </button>
      {error && (
        <p className="text-xs text-red-400 bg-red-500/10 border border-red-500/20 rounded-lg px-3 py-2 mt-3">
          {error}
        </p>
      )}
    </div>
  );
}
