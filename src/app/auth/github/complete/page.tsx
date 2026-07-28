import { Suspense } from "react";
import { GitHubCompleteClient } from "./github-complete-client";

export default function GitHubCompletePage() {
  return (
    <Suspense
      fallback={
        <div className="flex min-h-screen items-center justify-center bg-zinc-950">
          <p className="animate-pulse text-sm text-zinc-400">
            Completing GitHub sign-in…
          </p>
        </div>
      }
    >
      <GitHubCompleteClient />
    </Suspense>
  );
}
