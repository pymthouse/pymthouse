"use client";

import { useTurnkey } from "@turnkey/react-wallet-kit";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { bridgeTurnkeySessionToNextAuth } from "@/lib/turnkey-nextauth-bridge";

const BUTTON_CLASS =
  "flex w-full items-center justify-center gap-2 rounded-lg border border-zinc-700 bg-zinc-950/60 px-4 py-2.5 text-sm font-medium text-zinc-100 hover:border-zinc-500 hover:bg-zinc-900 disabled:cursor-not-allowed disabled:opacity-60";

type Step = "methods" | "email" | "code";

export function WalletIssuerLogin({
  callbackUrl,
  confirmEmail,
  emailOnly = false,
}: Readonly<{
  callbackUrl: string;
  confirmEmail?: string | null;
  emailOnly?: boolean;
}>) {
  const {
    createApiKeyPair,
    signWithApiKey,
    loginWithPasskey,
    clientState,
    getSession,
    refreshUser,
    refreshWallets,
    user,
    wallets,
  } = useTurnkey();
  const router = useRouter();
  const [step, setStep] = useState<Step>(confirmEmail ? "code" : "methods");
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [publicKey, setPublicKey] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [discordEnabled, setDiscordEnabled] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/auth/discord/enabled")
      .then((res) => (res.ok ? res.json() : null))
      .then((data: { enabled?: boolean } | null) => {
        if (!cancelled) setDiscordEnabled(!!data?.enabled);
      })
      .catch(() => {
        if (!cancelled) setDiscordEnabled(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  async function sessionKey(): Promise<string> {
    if (publicKey) return publicKey;
    const created = await createApiKeyPair();
    if (!created) throw new Error("Could not create a sign-in key");
    setPublicKey(created);
    return created;
  }

  async function startProvider(path: string) {
    setBusy(true);
    setError(null);
    try {
      const key = await sessionKey();
      const url = new URL(path, window.location.origin);
      url.searchParams.set("publicKey", key);
      url.searchParams.set("callbackUrl", callbackUrl);
      window.location.assign(url.toString());
    } catch (err) {
      setError(err instanceof Error ? err.message : "Sign-in failed");
      setBusy(false);
    }
  }

  async function sendCode(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const key = await sessionKey();
      const res = await fetch("/api/auth/otp/init", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, publicKey: key, callbackUrl }),
      });
      const data = (await res.json()) as { error?: string };
      if (!res.ok) throw new Error(data.error || "Could not send the code");
      setStep("code");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not send the code");
    } finally {
      setBusy(false);
    }
  }

  async function submitCode(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const key = await sessionKey();
      const verified = await fetch("/api/auth/otp/verify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code }),
      });
      const verifiedBody = (await verified.json()) as {
        error?: string;
        signatureMessage?: string;
      };
      if (!verified.ok || !verifiedBody.signatureMessage) {
        throw new Error(verifiedBody.error || "That code is invalid");
      }
      const signature = await signWithApiKey({
        message: verifiedBody.signatureMessage,
        publicKey: key,
      });
      if (!signature) throw new Error("Could not sign in");
      const finished = await fetch("/api/auth/otp/finish", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ signature }),
      });
      const finishedBody = (await finished.json()) as {
        error?: string;
        redirect?: string;
        step?: string;
      };
      if (!finished.ok) throw new Error(finishedBody.error || "Sign-in failed");
      if (finishedBody.redirect) {
        router.push(finishedBody.redirect);
        return;
      }
      if (finishedBody.step === "confirm") setStep("code");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Sign-in failed");
    } finally {
      setBusy(false);
    }
  }

  async function passkey() {
    setBusy(true);
    setError(null);
    try {
      await loginWithPasskey();
      const bridged = await bridgeTurnkeySessionToNextAuth({
        getSession,
        refreshUser,
        refreshWallets,
        wallets,
        user,
      });
      if (!bridged.ok) throw new Error(bridged.error);
      router.push(callbackUrl);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Passkey sign-in failed");
      setBusy(false);
    }
  }

  const disabled = busy || clientState === undefined;

  return (
    <div className="space-y-3">
      {confirmEmail ? (
        <p className="rounded-lg border border-amber-500/25 bg-amber-500/10 px-3 py-2 text-xs text-amber-200">
          Confirm it&apos;s you with a code sent to {confirmEmail}. You&apos;ll only do this once.
        </p>
      ) : null}
      {step === "methods" && !emailOnly ? (
        <>
          <button type="button" className={BUTTON_CLASS} disabled={disabled} onClick={() => void startProvider("/api/auth/google/start")}>
            Continue with Google
          </button>
          <button type="button" className={BUTTON_CLASS} disabled={disabled} onClick={() => void startProvider("/api/auth/github/start")}>
            Continue with GitHub
          </button>
          {discordEnabled ? (
            <button type="button" className={BUTTON_CLASS} disabled={disabled} onClick={() => void startProvider("/api/auth/discord/start")}>
              Continue with Discord
            </button>
          ) : null}
          <button type="button" className={BUTTON_CLASS} disabled={disabled} onClick={() => setStep("email")}>
            Continue with email
          </button>
          <button type="button" className={BUTTON_CLASS} disabled={disabled} onClick={() => void passkey()}>
            Sign in with passkey
          </button>
        </>
      ) : null}
      {(step === "email" || (emailOnly && step === "methods")) ? (
        <form className="space-y-2" onSubmit={(event) => void sendCode(event)}>
          <label className="block text-xs text-zinc-400" htmlFor="wallet-email">
            Email
          </label>
          <input
            id="wallet-email"
            type="email"
            required
            autoComplete="email"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            className="w-full rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm text-zinc-100"
          />
          <button type="submit" className={BUTTON_CLASS} disabled={disabled}>
            Send code
          </button>
        </form>
      ) : null}
      {step === "code" ? (
        <form className="space-y-2" onSubmit={(event) => void submitCode(event)}>
          <label className="block text-xs text-zinc-400" htmlFor="wallet-code">
            Email code
          </label>
          <input
            id="wallet-code"
            inputMode="numeric"
            autoComplete="one-time-code"
            required
            value={code}
            onChange={(event) => setCode(event.target.value)}
            className="w-full rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm text-zinc-100"
          />
          <button type="submit" className={BUTTON_CLASS} disabled={disabled}>
            Continue
          </button>
        </form>
      ) : null}
      {error ? (
        <p className="rounded-lg border border-red-500/20 bg-red-500/10 px-3 py-2 text-xs text-red-300">
          {error}
        </p>
      ) : null}
    </div>
  );
}
