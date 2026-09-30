import { Suspense } from "react";
import { WalletCompleteClient } from "./wallet-complete-client";

export default function WalletCompletePage() {
  return (
    <Suspense
      fallback={
        <div className="flex min-h-screen items-center justify-center bg-zinc-950">
          <p className="animate-pulse text-sm text-zinc-400">Signing you in…</p>
        </div>
      }
    >
      <WalletCompleteClient />
    </Suspense>
  );
}
