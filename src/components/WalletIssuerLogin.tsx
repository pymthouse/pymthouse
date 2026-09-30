"use client";

import { ClientState, useTurnkey } from "@turnkey/react-wallet-kit";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { bridgeTurnkeySessionToNextAuth } from "@/lib/turnkey-nextauth-bridge";

const BUTTON_CLASS =
  "flex w-full items-center justify-center gap-2 rounded-lg border border-zinc-700 bg-zinc-950/60 px-4 py-2.5 text-sm font-medium text-zinc-100 hover:border-zinc-500 hover:bg-zinc-900 disabled:cursor-not-allowed disabled:opacity-60";

type Step = "methods" | "email" | "code";
type CodePhase = "idle" | "sending" | "sent";

export function WalletIssuerLogin({
  callbackUrl,
  confirmEmail,
  emailOnly = false,
  initialEmail = null,
  autoSend = false,
  onStepChange,
}: Readonly<{
  callbackUrl: string;
  confirmEmail?: string | null;
  emailOnly?: boolean;
  initialEmail?: string | null;
  autoSend?: boolean;
  onStepChange?: (step: Step) => void;
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
  const [step, setStep] = useState<Step>(
    confirmEmail || (autoSend && initialEmail) ? "code" : emailOnly ? "email" : "methods",
  );
  const [email, setEmail] = useState(initialEmail ?? "");
  const [sentTo, setSentTo] = useState<string | null>(confirmEmail ?? initialEmail);
  const [codePhase, setCodePhase] = useState<CodePhase>(
    confirmEmail || (autoSend && initialEmail) ? "sending" : "idle",
  );
  const [code, setCode] = useState("");
  const [publicKey, setPublicKey] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [discordEnabled, setDiscordEnabled] = useState(false);
  const autoSent = useRef(false);

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

  useEffect(() => {
    onStepChange?.(step);
  }, [onStepChange, step]);

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

  async function deliverCode(target: { email?: string; confirm?: boolean }) {
    setBusy(true);
    setError(null);
    setStep("code");
    setCodePhase("sending");
    setCode("");
    const destination = target.confirm ? confirmEmail || "your email" : target.email || email;
    setSentTo(destination);
    try {
      const body = target.confirm
        ? { confirm: true }
        : { email: target.email || email, publicKey: await sessionKey(), callbackUrl };
      const res = await fetch("/api/auth/otp/init", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = (await res.json()) as { error?: string };
      if (!res.ok) throw new Error(data.error || "Could not send the code");
      setCodePhase("sent");
    } catch (err) {
      setCodePhase("idle");
      if (!target.confirm) setStep("email");
      setError(err instanceof Error ? err.message : "Could not send the code");
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => {
    if (autoSent.current) return;
    if (clientState === ClientState.Error && (confirmEmail || (autoSend && initialEmail))) {
      autoSent.current = true;
      setCodePhase("idle");
      if (!confirmEmail) setStep("email");
      setError("Couldn't start email sign-in. Enter the address and try again.");
      return;
    }
    if (clientState !== ClientState.Ready) return;
    if (confirmEmail) {
      autoSent.current = true;
      void deliverCode({ confirm: true });
      return;
    }
    if (autoSend && initialEmail) {
      autoSent.current = true;
      setEmail(initialEmail);
      void deliverCode({ email: initialEmail });
    }
    // Send once. deliverCode is recreated each render and must not re-trigger this.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoSend, clientState, confirmEmail, initialEmail]);

  async function sendCode(event: { preventDefault(): void }) {
    event.preventDefault();
    await deliverCode({ email });
  }

  async function submitCode(event: { preventDefault(): void }) {
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

  const destination = sentTo || confirmEmail || email;

  return (
    <div className="space-y-3">
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
      {step === "email" ? (
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
        <form className="space-y-3" onSubmit={(event) => void submitCode(event)}>
          <div className="rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-4 py-3">
            <p className="text-[11px] font-medium uppercase tracking-[0.14em] text-emerald-300">
              {codePhase === "sent" ? "Check your inbox" : "Email code"}
            </p>
            <p className="mt-1 text-sm text-zinc-100">
              {codePhase === "sent" ? (
                <>Enter the 6-digit code sent to <span className="font-medium">{destination}</span>.</>
              ) : codePhase === "sending" ? (
                <>Sending a 6-digit code to <span className="font-medium">{destination}</span>.</>
              ) : (
                <>We couldn&apos;t send a code to <span className="font-medium">{destination}</span>.</>
              )}
            </p>
          </div>
          {codePhase === "sent" ? (
            <input
              id="wallet-code"
              inputMode="numeric"
              autoComplete="one-time-code"
              autoFocus
              required
              maxLength={6}
              aria-label="6-digit email code"
              value={code}
              onChange={(event) => setCode(event.target.value.replace(/\D/g, "").slice(0, 6))}
              placeholder="000000"
              className="w-full rounded-lg border border-emerald-500/40 bg-zinc-950 px-3 py-3 text-center font-mono text-2xl tracking-[0.45em] text-zinc-100 placeholder:text-zinc-700"
            />
          ) : null}
          {codePhase === "sent" ? (
            <button
              type="submit"
              className="flex w-full items-center justify-center rounded-lg bg-emerald-600 px-4 py-2.5 text-sm font-medium text-white hover:bg-emerald-500 disabled:cursor-not-allowed disabled:opacity-60"
              disabled={disabled || code.length !== 6}
            >
              Verify code
            </button>
          ) : null}
          <div className="flex items-center justify-between gap-3 text-xs">
            {confirmEmail ? <span /> : (
              <button
                type="button"
                className="text-zinc-400 hover:text-zinc-200"
                onClick={() => {
                  setStep("email");
                  setCode("");
                  setCodePhase("idle");
                }}
              >
                Use a different email
              </button>
            )}
            <button
              type="button"
              className="text-zinc-400 hover:text-zinc-200 disabled:opacity-60"
              disabled={disabled}
              onClick={() => void deliverCode(confirmEmail ? { confirm: true } : { email })}
            >
              Resend code
            </button>
          </div>
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
