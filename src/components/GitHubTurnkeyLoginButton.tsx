"use client";

import { useTurnkey } from "@turnkey/react-wallet-kit";
import { useSearchParams } from "next/navigation";
import { useEffect, useState } from "react";
import { safeCallbackUrl } from "@/lib/turnkey-nextauth-bridge";

function GitHubMark({ className }: Readonly<{ className?: string }>) {
  return (
    <svg
      className={className}
      viewBox="0 0 16 16"
      fill="currentColor"
      aria-hidden
    >
      <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27s1.36.09 2 .27c1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8" />
    </svg>
  );
}

/**
 * Continues with GitHub via Turnkey BYO OIDC (not bare NextAuth).
 * Creates a Wallet Kit session keypair, then redirects through GitHub OAuth.
 */
export function GitHubTurnkeyLoginButton({
  primaryColor = "#10b981",
  sectionLabel = "Wallet and social",
  containerClassName = "mt-4 space-y-2",
}: Readonly<{
  primaryColor?: string;
  sectionLabel?: string | null;
  containerClassName?: string;
}>) {
  const { createApiKeyPair, clientState } = useTurnkey();
  const searchParams = useSearchParams();
  const callbackUrl = safeCallbackUrl(searchParams.get("callbackUrl"));

  const [enabled, setEnabled] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/auth/github/enabled")
      .then((res) => (res.ok ? res.json() : null))
      .then((data: { enabled?: boolean } | null) => {
        if (!cancelled) setEnabled(!!data?.enabled);
      })
      .catch(() => {
        if (!cancelled) setEnabled(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (!enabled) return null;

  const onClick = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const publicKey = await createApiKeyPair();
      if (!publicKey) {
        throw new Error("Could not create Turnkey session key");
      }
      const start = new URL("/api/auth/github/start", window.location.origin);
      start.searchParams.set("publicKey", publicKey);
      start.searchParams.set("callbackUrl", callbackUrl);
      window.location.assign(start.toString());
    } catch (err) {
      setError(err instanceof Error ? err.message : "GitHub sign-in failed");
      setBusy(false);
    }
  };

  const disabled = busy || clientState === undefined;

  return (
    <div className={containerClassName}>
      {sectionLabel ? (
        <p className="text-[11px] font-medium uppercase tracking-[0.18em] text-zinc-500">
          {sectionLabel}
        </p>
      ) : null}
      <button
        type="button"
        onClick={() => {
          void onClick();
        }}
        disabled={disabled}
        className="flex w-full items-center justify-center gap-2 rounded-lg border border-zinc-700 bg-zinc-950/60 px-4 py-2.5 text-sm font-medium text-zinc-100 transition-colors hover:border-zinc-500 hover:bg-zinc-900 disabled:cursor-not-allowed disabled:opacity-60"
        style={{
          // Keep brand accent subtle on focus only.
          ["--tw-ring-color" as string]: primaryColor,
        }}
      >
        <GitHubMark className="h-4 w-4" />
        {busy ? "Redirecting to GitHub…" : "Continue with GitHub"}
      </button>
      {error ? (
        <p className="text-xs text-red-400 bg-red-500/10 border border-red-500/20 rounded-lg px-3 py-2">
          {error}
        </p>
      ) : null}
    </div>
  );
}
