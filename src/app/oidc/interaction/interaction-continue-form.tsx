"use client";

import { useEffect, useRef } from "react";

import { oidcInteractionSubmitPath } from "@/lib/oidc/interaction-path";

export default function InteractionContinueForm({
  uid,
}: Readonly<{
  uid: string;
}>) {
  const formRef = useRef<HTMLFormElement>(null);

  useEffect(() => {
    formRef.current?.submit();
  }, []);

  return (
    <main className="min-h-screen bg-zinc-950 text-zinc-100 flex items-center justify-center p-6">
      <div className="max-w-md w-full border border-zinc-800 bg-zinc-900/40 rounded-xl p-6">
        <h1 className="text-lg font-semibold text-zinc-100 mb-2">Continuing</h1>
        <p className="text-sm text-zinc-400 mb-4">
          Returning to the authorization request.
        </p>
        <form
          ref={formRef}
          method="POST"
          action={oidcInteractionSubmitPath(uid)}
        >
          <button
            type="submit"
            className="w-full px-4 py-2.5 text-sm font-medium text-zinc-950 bg-emerald-500 hover:bg-emerald-400 rounded-lg"
          >
            Continue
          </button>
        </form>
      </div>
    </main>
  );
}
