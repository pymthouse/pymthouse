"use client";

import { sanitizeUrl } from "@braintree/sanitize-url";
import {
  AuthState,
  ClientState,
  useTurnkey,
} from "@turnkey/react-wallet-kit";
import { signIn, useSession } from "next-auth/react";
import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useState } from "react";
import { MarketingFooter } from "@/components/MarketingFooter";

/** Temporarily hide direct Google OAuth on the login page. Re-enable when ready. */
const SHOW_GOOGLE_LOGIN = false;

interface AppBranding {
  mode: "blackLabel" | "whiteLabel";
  displayName: string;
  logoUrl: string | null;
  primaryColor: string;
}

function TurnkeyLoginButton({ primaryColor = "#10b981" }: { primaryColor?: string }) {
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

  return <TurnkeyLoginButtonInner primaryColor={primaryColor} />;
}

function TurnkeyLoginButtonInner({ primaryColor = "#10b981" }: { primaryColor?: string }) {
  const {
    handleLogin,
    authState,
    clientState,
    getSession,
    refreshWallets,
    refreshUser,
    user,
    wallets,
    logout,
  } = useTurnkey();
  const { status: nextAuthStatus } = useSession();
  const [bridging, setBridging] = useState(false);
  const [bridgeRequested, setBridgeRequested] = useState(false);
  const [handleLoginPending, setHandleLoginPending] = useState(false);
  const [failed, setFailed] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const router = useRouter();
  const searchParams = useSearchParams();
  const rawCallbackUrl = searchParams.get("callbackUrl") || "/dashboard";
  const callbackUrl =
    rawCallbackUrl.startsWith("/") && !rawCallbackUrl.startsWith("//")
      ? rawCallbackUrl
      : "/dashboard";

  useEffect(() => {
    if (
      !bridgeRequested ||
      authState !== AuthState.Authenticated ||
      clientState !== ClientState.Ready ||
      bridging ||
      failed
    ) {
      return;
    }

    (async () => {
      setBridging(true);
      setError(null);
      try {
        await refreshUser();
        await refreshWallets();
        const session = await getSession();
        if (!session?.token) {
          setError("Could not get session token");
          setFailed(true);
          setBridgeRequested(false);
          setBridging(false);
          return;
        }

        const walletAddress = firstEvmAddressFromWallets(wallets);
        const email = user?.userEmail?.trim() || undefined;
        const name = user?.userName?.trim() || undefined;

        const result = await signIn("turnkey-wallet", {
          turnkeySessionJwt: session.token,
          walletAddress: walletAddress || "",
          email: email || "",
          name: name || "",
          redirect: false,
        });

        if (result?.error) {
          setError("Authentication failed — check server logs");
          setFailed(true);
          setBridgeRequested(false);
          setBridging(false);
        } else if (result?.ok) {
          setBridgeRequested(false);
          router.push(callbackUrl);
        }
      } catch {
        setError("Authentication failed");
        setFailed(true);
        setBridgeRequested(false);
        setBridging(false);
      }
    })();
  }, [
    bridgeRequested,
    authState,
    clientState,
    bridging,
    failed,
    getSession,
    refreshUser,
    refreshWallets,
    router,
    callbackUrl,
    wallets,
    user,
  ]);

  return (
    <div>
      <button
        type="button"
        onClick={() => {
          setFailed(false);
          setError(null);
          void (async () => {
            setHandleLoginPending(true);
            try {
              if (
                nextAuthStatus === "unauthenticated" &&
                authState === AuthState.Authenticated
              ) {
                await logout();
              }
              await handleLogin();
              setBridgeRequested(true);
            } catch {
              setError("Authentication failed");
              setFailed(true);
              setBridgeRequested(false);
            } finally {
              setHandleLoginPending(false);
            }
          })();
        }}
        disabled={
          bridging ||
          handleLoginPending ||
          clientState === ClientState.Loading
        }
        className="w-full px-4 py-3 text-white rounded-lg text-sm font-medium hover:opacity-90 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
        style={{ backgroundColor: primaryColor }}
      >
        {bridging || handleLoginPending
          ? "Connecting..."
          : "Sign In / Create Account"}
      </button>
      {error && (
        <p className="text-xs text-red-400 bg-red-500/10 border border-red-500/20 rounded-lg px-3 py-2 mt-3">
          {error}
        </p>
      )}
    </div>
  );
}

function firstEvmAddressFromWallets(
  wallets: { accounts: { address: string }[] }[],
): string | undefined {
  for (const w of wallets) {
    for (const a of w.accounts) {
      const addr = a.address;
      if (typeof addr === "string" && addr.startsWith("0x")) {
        return addr;
      }
    }
  }
  return undefined;
}

export function LoginForm() {
  const { data: session, status } = useSession();
  const router = useRouter();
  const searchParams = useSearchParams();
  const [token, setToken] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [adminSectionOpen, setAdminSectionOpen] = useState(false);
  const [branding, setBranding] = useState<AppBranding | null>(null);
  const callbackUrl = searchParams.get("callbackUrl") || "/dashboard";
  const safeCallbackUrl =
    callbackUrl.startsWith("/") && !callbackUrl.startsWith("//")
      ? callbackUrl
      : "/dashboard";
  const clientId = searchParams.get("client_id");
  const isAdmin = searchParams.get("admin") === "1";
  const isOidcFlow = callbackUrl.includes("/oidc/");
  const authError = searchParams.get("error");
  const accessDenied =
    authError === "AccessDenied" ||
    (typeof authError === "string" && authError.includes("AccessDenied"));
  const oauthCallbackMessage = accessDenied
    ? isAdmin
      ? "OAuth sign-in was denied. Admin accounts must use a bearer token from npm run bootstrap, not Google or GitHub."
      : "Sign-in was denied. You can try again or use a different sign-in method."
    : authError
      ? "Sign-in failed. Please try again."
      : null;

  useEffect(() => {
    if (clientId && isOidcFlow) {
      fetch(`/api/v1/apps/branding?client_id=${encodeURIComponent(clientId)}`)
        .then((res) => (res.ok ? res.json() : null))
        .then((data) => {
          if (data?.branding) {
            setBranding(data.branding);
          }
        })
        .catch(() => {});
    }
  }, [clientId, isOidcFlow]);

  const isWhiteLabel = branding?.mode === "whiteLabel";
  const primaryColor = branding?.primaryColor || "#10b981";
  const logoUrl = toSafeLogoUrl(branding?.logoUrl ?? null);

  useEffect(() => {
    if (status === "authenticated" && session) {
      router.push(safeCallbackUrl);
    }
  }, [session, status, router, safeCallbackUrl]);

  useEffect(() => {
    if (!isAdmin) return;
    queueMicrotask(() => {
      setAdminSectionOpen(true);
    });
  }, [isAdmin]);

  async function handleTokenLogin(e: React.FormEvent) {
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
          {isWhiteLabel && branding ? (
            <>
              {logoUrl && (
                // Tenant logo URLs are dynamic, so next/image remote host config cannot enumerate them.
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={logoUrl}
                  alt={branding.displayName}
                  className="h-12 w-auto mx-auto mb-4"
                />
              )}
              <h1 className="text-3xl font-bold tracking-tight text-zinc-100">
                {branding.displayName}
              </h1>
              <p className="text-zinc-500 mt-2 text-sm">Sign in to continue</p>
            </>
          ) : (
            <>
              <h1 className="text-3xl font-bold tracking-tight">
                <span className="text-emerald-400">pymt</span>house
              </h1>
              <p className="text-zinc-500 mt-2 text-sm">
                Identity & Payment Infrastructure
              </p>
            </>
          )}
        </div>

        <div className="border border-zinc-800 rounded-xl p-6 bg-zinc-900/30 mb-4">
          <h2 className="text-lg font-semibold text-zinc-200 mb-1">
            {isWhiteLabel ? "Sign In" : "Developer Sign In"}
          </h2>
          <p className="text-sm text-zinc-500 mb-5">
            Sign in with passkey, email OTP, wallet, or social (via Turnkey).
          </p>
          <TurnkeyLoginButton primaryColor={primaryColor} />
          {!isAdmin && (
            <div className="mt-5 pt-5 border-t border-zinc-800 space-y-3">
              <p className="text-xs text-zinc-500 leading-relaxed">
                For developer accounts only.
              </p>
              <div className="space-y-2">
                {SHOW_GOOGLE_LOGIN ? (
                  <button
                    type="button"
                    onClick={() =>
                      signIn("google", { callbackUrl: safeCallbackUrl })
                    }
                    className="w-full flex items-center justify-center gap-3 px-4 py-2.5 border border-zinc-700 rounded-lg hover:bg-zinc-800/50 transition-colors text-sm font-medium text-zinc-300"
                  >
                    Google
                  </button>
                ) : null}
                <button
                  type="button"
                  onClick={() =>
                    signIn("github", { callbackUrl: safeCallbackUrl })
                  }
                  className="w-full flex items-center justify-center gap-3 px-4 py-2.5 border border-zinc-700 rounded-lg hover:bg-zinc-800/50 transition-colors text-sm font-medium text-zinc-300"
                >
                  GitHub
                </button>
              </div>
            </div>
          )}
          {oauthCallbackMessage && (
            <p className="text-xs text-amber-300/90 bg-amber-500/10 border border-amber-500/25 rounded-lg px-3 py-2 mt-4">
              {oauthCallbackMessage}
            </p>
          )}
        </div>

        <div className="border border-zinc-800 rounded-xl bg-zinc-900/30 mb-4">
          <button
            type="button"
            onClick={() => setAdminSectionOpen(!adminSectionOpen)}
            className="w-full px-6 py-4 flex items-center justify-between text-left"
          >
            <span className="text-xs text-zinc-500 uppercase tracking-wider">
              Admin sign-in
            </span>
            <svg
              className={`w-4 h-4 text-zinc-500 transition-transform ${adminSectionOpen ? "rotate-180" : ""}`}
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M19 9l-7 7-7-7"
              />
            </svg>
          </button>

          {adminSectionOpen && (
            <div className="px-6 pb-6 space-y-3">
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
                <button
                  type="submit"
                  disabled={loading || !token.trim()}
                  className="w-full px-4 py-2.5 bg-zinc-700 text-zinc-200 rounded-lg text-sm font-medium hover:bg-zinc-600 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  {loading ? "Signing in..." : "Sign in with Token"}
                </button>
              </form>
            </div>
          )}
        </div>

        {isWhiteLabel ? (
          <footer className="mt-6 pt-4 text-center">
            <p className="text-xs text-zinc-600">
              Identity powered by{" "}
              <span className="text-zinc-500">
                <span className="text-emerald-500">pymt</span>house
              </span>
            </p>
          </footer>
        ) : (
          <MarketingFooter className="mt-6" />
        )}
      </div>
    </div>
  );
}

/** Returns a sanitized URL, or null for anything unsafe. */
function toSafeLogoUrl(url: string | null): string | null {
  if (!url) return null;
  const trimmed = url.trim();
  if (!trimmed) return null;
  if (trimmed.startsWith("//")) return null;
  const safe = sanitizeUrl(trimmed);
  return safe === "about:blank" ? null : safe;
}
