"use client";

import {
  AuthState,
  ClientState,
  useTurnkey,
} from "@turnkey/react-wallet-kit";
import { OAuthProviders } from "@turnkey/sdk-types";
import { useSearchParams } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import { loginAuthErrorMessage } from "@/lib/login-auth-error";
import {
  isTurnkeyAccountAlreadyExistsError,
  oauthAccountExistsMessage,
} from "@/lib/turnkey-account-exists";
import {
  type SignInMethodId,
  signInMethodStatuses,
} from "@/lib/turnkey-sign-in-methods";
import { isTurnkeyWalletConfigured } from "@/lib/turnkey-wallet-config";

const AUTH_BUTTON_CLASS =
  "inline-flex h-[30px] items-center justify-center rounded-lg border border-zinc-700 px-3 text-xs font-medium text-zinc-100 transition-colors hover:border-zinc-500 hover:bg-zinc-900 disabled:cursor-not-allowed disabled:opacity-60";

export function SignInMethodsPanel() {
  if (!isTurnkeyWalletConfigured()) {
    return (
      <section className="rounded-md border border-zinc-800 bg-zinc-900/40 px-4 py-3.5">
        <h2 className="text-sm font-medium text-zinc-100">Sign-in methods</h2>
        <p className="mt-2 text-sm text-zinc-500">
          Turnkey Wallet Kit is not configured in this environment.
        </p>
      </section>
    );
  }

  return <SignInMethodsPanelInner />;
}

function SignInMethodsPanelInner() {
  const {
    authState,
    clientState,
    config,
    user,
    refreshUser,
    handleAddOauthProvider,
    addOauthProvider,
    createApiKeyPair,
  } = useTurnkey();
  const searchParams = useSearchParams();
  const [githubEnabled, setGithubEnabled] = useState(false);
  const [busyMethod, setBusyMethod] = useState<SignInMethodId | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const githubLinkStarted = useRef(false);

  const googleEnabled =
    config?.ui?.authModal?.methods?.googleOauthEnabled !== false;
  const discordEnabled = Boolean(
    config?.ui?.authModal?.methods?.discordOauthEnabled,
  );

  useEffect(() => {
    let cancelled = false;
    fetch("/api/auth/github/enabled")
      .then((res) => (res.ok ? res.json() : null))
      .then((data: { enabled?: boolean } | null) => {
        if (!cancelled) setGithubEnabled(!!data?.enabled);
      })
      .catch(() => {
        if (!cancelled) setGithubEnabled(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    const oauthError = loginAuthErrorMessage(
      searchParams.get("error"),
      searchParams.get("email"),
      searchParams.get("provider"),
    );
    if (oauthError) setError(oauthError);
  }, [searchParams]);

  useEffect(() => {
    if (searchParams.get("link") !== "github") return;
    if (githubLinkStarted.current) return;
    if (clientState !== ClientState.Ready) return;
    if (authState !== AuthState.Authenticated) return;

    githubLinkStarted.current = true;
    setBusyMethod("github");
    setError(null);
    (async () => {
      const res = await fetch("/api/auth/github/oidc", { method: "POST" });
      if (!res.ok) {
        throw new Error("GitHub link token expired. Please try again.");
      }
      const data = (await res.json()) as { oidcToken?: string };
      if (!data.oidcToken) {
        throw new Error("GitHub link token expired. Please try again.");
      }
      await addOauthProvider({
        providerName: "GitHub",
        oidcToken: data.oidcToken,
      });
      await refreshUser();
      setNotice("GitHub is now a sign-in method on this account.");
      setBusyMethod(null);
    })().catch((err: unknown) => {
      githubLinkStarted.current = false;
      setBusyMethod(null);
      setError(err instanceof Error ? err.message : "Could not link GitHub");
    });
  }, [searchParams, clientState, authState, addOauthProvider, refreshUser]);

  const methods = useMemo(
    () =>
      signInMethodStatuses({
        user,
        googleEnabled,
        githubEnabled,
        discordEnabled,
      }),
    [user, googleEnabled, githubEnabled, discordEnabled],
  );

  const sessionReady =
    clientState === ClientState.Ready && authState === AuthState.Authenticated;

  const addMethod = async (id: SignInMethodId) => {
    if (busyMethod || !sessionReady) return;
    setBusyMethod(id);
    setError(null);
    setNotice(null);
    try {
      if (id === "google") {
        await handleAddOauthProvider({
          providerName: OAuthProviders.GOOGLE,
          openInPage: true,
        });
        await refreshUser();
        setNotice("Google is now a sign-in method on this account.");
        return;
      }
      if (id === "discord") {
        await handleAddOauthProvider({
          providerName: OAuthProviders.DISCORD,
          openInPage: true,
        });
        await refreshUser();
        setNotice("Discord is now a sign-in method on this account.");
        return;
      }
      if (id === "github") {
        const publicKey = await createApiKeyPair();
        if (!publicKey) {
          throw new Error("Could not create Turnkey session key");
        }
        const start = new URL("/api/auth/github/start", window.location.origin);
        start.searchParams.set("publicKey", publicKey);
        start.searchParams.set("intent", "link");
        start.searchParams.set("callbackUrl", "/account");
        window.location.assign(start.toString());
        return;
      }
    } catch (err) {
      if (isTurnkeyAccountAlreadyExistsError(err)) {
        setError(oauthAccountExistsMessage(id));
      } else {
        setError(
          err instanceof Error ? err.message : "Could not add sign-in method",
        );
      }
    } finally {
      if (id !== "github") setBusyMethod(null);
    }
  };

  return (
    <section className="rounded-md border border-zinc-800 bg-zinc-900/40">
      <div className="border-b border-zinc-800 px-4 py-3.5">
        <h2 className="text-sm font-medium text-zinc-100">Sign-in methods</h2>
        <p className="mt-1 text-sm text-zinc-500">
          Methods that can open this wallet. Adding one never creates a second account.
        </p>
      </div>
      {!sessionReady ? (
        <p className="px-4 py-3 text-sm text-zinc-500">
          Sign in again on this device to add a method. Linking has to be stamped
          by your live Turnkey session.
        </p>
      ) : null}
      <ul className="divide-y divide-zinc-800">
        {methods.map((method) => (
          <li
            key={method.id}
            className="flex items-center justify-between gap-3 px-4 py-3"
          >
            <div>
              <p className="text-sm font-medium text-zinc-100">{method.label}</p>
              <p className="text-xs text-zinc-500">
                {method.linked ? "Connected" : "Not connected"}
              </p>
            </div>
            {method.linked ? (
              <span className="rounded-full border border-emerald-500/20 bg-emerald-500/10 px-2 py-0.5 text-[11px] font-medium text-emerald-400">
                Linked
              </span>
            ) : method.canAdd ? (
              <button
                type="button"
                className={AUTH_BUTTON_CLASS}
                disabled={!sessionReady || busyMethod !== null}
                onClick={() => {
                  void addMethod(method.id);
                }}
              >
                {busyMethod === method.id ? "Adding…" : "Add"}
              </button>
            ) : (
              <span className="text-xs text-zinc-600">—</span>
            )}
          </li>
        ))}
      </ul>
      {notice ? (
        <p className="border-t border-zinc-800 px-4 py-3 text-xs text-emerald-400">
          {notice}
        </p>
      ) : null}
      {error ? (
        <p className="border-t border-zinc-800 px-4 py-3 text-xs text-red-400">
          {error}
        </p>
      ) : null}
    </section>
  );
}
