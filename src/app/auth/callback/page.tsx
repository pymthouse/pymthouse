import { Suspense } from "react";
import { OAuthCallbackClient } from "./oauth-callback-client";

export default function AuthCallbackPage() {
  return (
    <Suspense
      fallback={
        <div className="flex min-h-screen flex-col items-center justify-center bg-zinc-950 px-6">
          <p className="text-2xl font-bold tracking-tight mb-6">
            <span className="text-emerald-400">pymt</span>house
          </p>
          <p className="text-sm text-zinc-400 animate-pulse">
            Completing sign-in…
          </p>
        </div>
      }
    >
      <OAuthCallbackClient />
    </Suspense>
  );
}
