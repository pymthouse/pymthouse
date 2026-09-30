"use client";

import { useCallback, useState } from "react";
import { signOut } from "next-auth/react";
import { ClientState, useTurnkey } from "@turnkey/react-wallet-kit";
import { WalletIssuerLogin } from "@/components/WalletIssuerLogin";
import { brandedSignInIdentity, type BrandedSignIn } from "@/lib/turnkey-sign-in-methods";

function usableEmail(value: string | null | undefined): string | null {
  const email = value?.trim().toLowerCase() ?? "";
  if (!email.includes("@") || email.endsWith("@turnkey.local")) return null;
  return email;
}

function ProviderMark({
  provider,
}: Readonly<{ provider: BrandedSignIn["provider"] }>) {
  if (provider === "google") {
    return (
      <svg className="h-4 w-4" viewBox="0 0 24 24" aria-hidden>
        <path fill="#4285F4" d="M23.49 12.27c0-.79-.07-1.55-.2-2.27H12v4.29h6.45a5.52 5.52 0 0 1-2.4 3.62v3h3.88c2.28-2.1 3.56-5.19 3.56-8.64Z" />
        <path fill="#34A853" d="M12 24c3.24 0 5.95-1.07 7.93-2.91l-3.88-3c-1.08.73-2.46 1.16-4.05 1.16-3.12 0-5.76-2.1-6.7-4.93H1.3v3.1A12 12 0 0 0 12 24Z" />
        <path fill="#FBBC05" d="M5.3 14.32A7.2 7.2 0 0 1 4.93 12c0-.8.14-1.57.37-2.32v-3.1H1.3A12 12 0 0 0 0 12c0 1.93.46 3.76 1.3 5.42l4-3.1Z" />
        <path fill="#EA4335" d="M12 4.77c1.76 0 3.33.61 4.57 1.8l3.43-3.43C17.94 1.19 15.23 0 12 0A12 12 0 0 0 1.3 6.58l4 3.1C6.23 6.87 8.88 4.77 12 4.77Z" />
      </svg>
    );
  }
  if (provider === "discord") {
    return (
      <svg className="h-4 w-4 text-[#5865F2]" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
        <path d="M20.32 4.37a19.8 19.8 0 0 0-4.9-1.52.07.07 0 0 0-.07.04l-.62 1.11a18.2 18.2 0 0 0-5.46 0l-.63-1.1a.07.07 0 0 0-.07-.05c-1.7.28-3.35.8-4.9 1.52a.06.06 0 0 0-.03.02C.53 9.08-.2 13.66.16 18.17c0 .03.02.05.04.07 2 1.48 3.95 2.38 5.87 2.98a.07.07 0 0 0 .08-.02l1.2-1.65c-1.28-.48-2.5-1.1-3.66-1.9a.07.07 0 0 1-.01-.12c.24-.18.49-.36.72-.55a.07.07 0 0 1 .08-.01c7.66 3.5 15.97 3.5 23.54 0a.07.07 0 0 1 .08.01l.72.55a.07.07 0 0 1-.01.12c-1.16.8-2.38 1.42-3.66 1.9l1.2 1.65a.07.07 0 0 0 .08.02c1.93-.6 3.88-1.5 5.87-2.98a.07.07 0 0 0 .04-.07c.43-5.2-.72-9.74-3.42-13.78a.06.06 0 0 0-.03-.02ZM8.28 15.4c-1.45 0-2.64-1.34-2.64-2.98 0-1.64 1.17-2.98 2.64-2.98 1.48 0 2.66 1.35 2.64 2.98 0 1.64-1.17 2.98-2.64 2.98Zm7.44 0c-1.45 0-2.64-1.34-2.64-2.98 0-1.64 1.17-2.98 2.64-2.98 1.48 0 2.66 1.35 2.64 2.98 0 1.64-1.16 2.98-2.64 2.98Z" />
      </svg>
    );
  }
  if (provider === "github") {
    return (
      <svg className="h-4 w-4" viewBox="0 0 16 16" fill="currentColor" aria-hidden>
        <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27s1.36.09 2 .27c1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8" />
      </svg>
    );
  }
  return (
    <span className="flex h-4 w-4 items-center justify-center rounded-full bg-zinc-700 text-[10px] text-zinc-200" aria-hidden>
      @
    </span>
  );
}

export function VerifyEmailForm({
  identity,
  email,
}: Readonly<{
  identity: BrandedSignIn | null;
  email: string | null;
}>) {
  const { clientState, logout, user } = useTurnkey();
  const live = brandedSignInIdentity(user?.oauthProviders, user?.userName);
  const shown = identity && identity.provider !== "wallet" ? identity : live ?? identity;
  const knownEmail = email ?? usableEmail(user?.userEmail);
  const turnkeySettled = clientState === ClientState.Ready || clientState === ClientState.Error;
  const [onCode, setOnCode] = useState(Boolean(knownEmail));
  const onStepChange = useCallback((step: "methods" | "email" | "code") => {
    setOnCode(step === "code");
  }, []);

  function logOut() {
    void logout()
      .catch(() => undefined)
      .then(() => signOut({ callbackUrl: "/login" }));
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-zinc-950 px-4">
      <div className="w-full max-w-sm rounded-xl border border-zinc-800 bg-zinc-900/30 p-6">
        <div className="mb-4 flex items-start justify-between gap-3">
          <div>
            {onCode ? null : (
              <>
                <h1 className="text-lg font-semibold text-zinc-100">Verify your email</h1>
                <p className="mt-1 text-sm text-zinc-500">
                  This login needs a verified email before you can continue.
                </p>
              </>
            )}
          </div>
          <button
            type="button"
            onClick={logOut}
            className="shrink-0 rounded-lg border border-zinc-700 px-2.5 py-1 text-xs text-zinc-300 hover:border-zinc-500 hover:text-zinc-100"
          >
            Log out
          </button>
        </div>
        {shown ? (
          <div className="mb-4 flex items-center gap-3 rounded-lg border border-zinc-800 bg-zinc-950/70 px-3 py-2">
            <ProviderMark provider={shown.provider} />
            <div className="min-w-0">
              <p className="text-[11px] font-medium uppercase tracking-wide text-zinc-500">
                {shown.label}
              </p>
              <p className="truncate font-mono text-sm text-zinc-100" title={shown.userId}>
                {shown.userId}
              </p>
            </div>
          </div>
        ) : null}
        {email || turnkeySettled ? (
          <WalletIssuerLogin
            callbackUrl="/onboarding"
            emailOnly
            initialEmail={knownEmail}
            autoSend={Boolean(knownEmail)}
            onStepChange={onStepChange}
          />
        ) : (
          <p className="text-sm text-zinc-500">Checking this sign-in…</p>
        )}
      </div>
    </div>
  );
}
