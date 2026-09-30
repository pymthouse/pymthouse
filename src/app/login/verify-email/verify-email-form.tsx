"use client";

import { WalletIssuerLogin } from "@/components/WalletIssuerLogin";

export function VerifyEmailForm() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-zinc-950 px-4">
      <div className="w-full max-w-sm rounded-xl border border-zinc-800 bg-zinc-900/30 p-6">
        <h1 className="text-lg font-semibold text-zinc-100">Verify your email</h1>
        <p className="mt-1 mb-4 text-sm text-zinc-500">
          This login needs a verified email before you can continue.
        </p>
        <WalletIssuerLogin callbackUrl="/onboarding" emailOnly />
      </div>
    </div>
  );
}
