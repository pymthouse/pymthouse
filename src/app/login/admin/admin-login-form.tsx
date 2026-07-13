"use client";

import { signIn, useSession } from "next-auth/react";
import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useState } from "react";
import { MarketingFooter } from "@/components/MarketingFooter";

export function AdminLoginForm() {
  const { data: session, status } = useSession();
  const router = useRouter();
  const searchParams = useSearchParams();
  const [token, setToken] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const callbackUrl = searchParams.get("callbackUrl") || "/apps";
  const safeCallbackUrl =
    callbackUrl.startsWith("/") && !callbackUrl.startsWith("//")
      ? callbackUrl
      : "/apps";
  const authError = searchParams.get("error");
  const accessDenied =
    authError === "AccessDenied" ||
    (typeof authError === "string" && authError.includes("AccessDenied"));
  let oauthCallbackMessage: string | null = null;
  if (accessDenied) {
    oauthCallbackMessage =
      "OAuth sign-in was denied. Admin accounts must use a bearer token from npm run bootstrap.";
  } else if (authError) {
    oauthCallbackMessage = "Sign-in failed. Please try again.";
  }

  useEffect(() => {
    if (status === "authenticated" && session) {
      router.push(safeCallbackUrl);
    }
  }, [session, status, router, safeCallbackUrl]);

  async function handleTokenLogin(e: React.SyntheticEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!token.trim()) return;

    setLoading(true);
    setError(null);

    const result = await signIn("token", {
      token: token.trim(),
      redirect: false,
    });

    if (result?.error) {
      setError("Invalid token or insufficient permissions.");
      setLoading(false);
    } else if (result?.ok) {
      router.push(safeCallbackUrl);
    }
  }

  if (status === "authenticated") {
    return (
      <div className="flex items-center justify-center min-h-screen bg-zinc-950">
        <div className="animate-pulse text-zinc-500">Redirecting...</div>
      </div>
    );
  }

  if (status === "loading") {
    return (
      <div className="flex items-center justify-center min-h-screen bg-zinc-950">
        <div className="animate-pulse text-zinc-500">Loading...</div>
      </div>
    );
  }

  return (
    <div className="flex items-center justify-center min-h-screen bg-zinc-950">
      <div className="w-full max-w-sm">
        <div className="text-center mb-8">
          <h1 className="text-3xl font-bold tracking-tight">
            <span className="text-emerald-400">pymt</span>house
          </h1>
          <p className="text-zinc-500 mt-2 text-sm">Admin sign-in</p>
        </div>

        <div className="border border-zinc-800 rounded-xl p-6 bg-zinc-900/30 mb-4">
          <h2 className="text-lg font-semibold text-zinc-200 mb-1">
            Sign in with token
          </h2>
          <p className="text-sm text-zinc-500 mb-5">
            Use a bearer token from{" "}
            <code className="text-zinc-400">npm run bootstrap</code>.
          </p>
          <form onSubmit={handleTokenLogin} className="space-y-3">
            <input
              type="password"
              value={token}
              onChange={(e) => {
                setToken(e.target.value);
                setError(null);
              }}
              placeholder="pmth_..."
              className="w-full px-3 py-2.5 bg-zinc-800/50 border border-zinc-700 rounded-lg text-sm text-zinc-200 focus:outline-none focus:border-emerald-500/50 font-mono placeholder:font-sans placeholder:text-zinc-600"
            />
            {error && (
              <p className="text-xs text-red-400 bg-red-500/10 border border-red-500/20 rounded-lg px-3 py-2">
                {error}
              </p>
            )}
            {oauthCallbackMessage && (
              <p className="text-xs text-amber-300/90 bg-amber-500/10 border border-amber-500/25 rounded-lg px-3 py-2">
                {oauthCallbackMessage}
              </p>
            )}
            <button
              type="submit"
              disabled={loading || !token.trim()}
              className="w-full px-4 py-2.5 bg-zinc-700 text-zinc-200 rounded-lg text-sm font-medium hover:bg-zinc-600 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {loading ? "Signing in..." : "Sign in with Token"}
            </button>
          </form>
        </div>

        <p className="text-center text-xs text-zinc-600 mb-4">
          <a
            href="/login"
            className="text-zinc-500 hover:text-zinc-300 transition-colors"
          >
            ← Developer sign-in
          </a>
        </p>

        <MarketingFooter className="mt-6" />
      </div>
    </div>
  );
}
