"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";
import { useSession, signIn } from "next-auth/react";

type PaymentRequirements = {
  scheme: string;
  network: string;
  asset: string;
  amount: string;
  payTo: string;
  maxTimeoutSeconds?: number;
  extra?: { name?: string; version?: string };
};

type LookupResponse = {
  status: string;
  userCode?: string;
  paymentRequirements?: PaymentRequirements;
  expiresAt?: string;
  error?: string;
};

function formatUsdc(amountAtomic: string): string {
  try {
    const value = BigInt(amountAtomic);
    const whole = value / 1_000_000n;
    const frac = (value % 1_000_000n).toString().padStart(6, "0").replace(/0+$/, "");
    return frac ? `${whole}.${frac}` : whole.toString();
  } catch {
    return amountAtomic;
  }
}

export default function X402ApprovePage() {
  const searchParams = useSearchParams();
  const initialCode = (searchParams.get("user_code") || "").toUpperCase();
  const { data: session, status: sessionStatus } = useSession();

  const [userCode, setUserCode] = useState(initialCode);
  const [lookup, setLookup] = useState<LookupResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [signedPayloadJson, setSignedPayloadJson] = useState("");
  const [done, setDone] = useState<string | null>(null);

  const load = useCallback(async (code: string) => {
    setError(null);
    setLookup(null);
    setDone(null);
    if (!code.trim()) {
      return;
    }
    setBusy(true);
    try {
      const res = await fetch(
        `/api/v1/x402/payment-codes/${encodeURIComponent(code.trim())}/approve`,
      );
      const json = (await res.json()) as LookupResponse;
      if (!res.ok) {
        setError(json.error || `Lookup failed (${res.status})`);
        return;
      }
      setLookup(json);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Lookup failed");
    } finally {
      setBusy(false);
    }
  }, []);

  useEffect(() => {
    if (initialCode) {
      void load(initialCode);
    }
  }, [initialCode, load]);

  const requirements = lookup?.paymentRequirements;
  const canApprove = useMemo(
    () =>
      Boolean(
        session &&
          lookup?.status === "pending" &&
          requirements &&
          signedPayloadJson.trim(),
      ),
    [session, lookup, requirements, signedPayloadJson],
  );

  const submit = async (action: "approve" | "deny") => {
    if (!userCode.trim()) {
      return;
    }
    setBusy(true);
    setError(null);
    try {
      let paymentPayload: unknown = undefined;
      if (action === "approve") {
        paymentPayload = JSON.parse(signedPayloadJson);
      }
      const res = await fetch(
        `/api/v1/x402/payment-codes/${encodeURIComponent(userCode.trim())}/approve`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            action,
            paymentPayload,
          }),
        },
      );
      const json = (await res.json()) as { status?: string; error?: string };
      if (!res.ok) {
        setError(json.error || `Request failed (${res.status})`);
        return;
      }
      setDone(json.status || action);
      await load(userCode);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Request failed");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-100">
      <div className="mx-auto max-w-lg px-4 py-12">
        <h1 className="text-2xl font-semibold tracking-tight">Approve x402 payment</h1>
        <p className="mt-2 text-sm text-zinc-400">
          An agent requested payment. Sign an EIP-3009 USDC authorization with your
          wallet, then approve to release the signed payload to the agent.
        </p>

        <div className="mt-8 space-y-4 rounded-xl border border-zinc-800 bg-zinc-900/50 p-5">
          <label className="block text-sm">
            <span className="text-zinc-400">User code</span>
            <div className="mt-1 flex gap-2">
              <input
                value={userCode}
                onChange={(e) => setUserCode(e.target.value.toUpperCase())}
                className="flex-1 rounded-md border border-zinc-700 bg-zinc-950 px-3 py-2 font-mono text-sm"
                placeholder="ABCD-EFGH"
              />
              <button
                type="button"
                disabled={busy || !userCode.trim()}
                onClick={() => void load(userCode)}
                className="rounded-md bg-zinc-100 px-3 py-2 text-sm font-medium text-zinc-900 disabled:opacity-50"
              >
                Look up
              </button>
            </div>
          </label>

          {sessionStatus === "unauthenticated" ? (
            <button
              type="button"
              onClick={() => void signIn()}
              className="w-full rounded-md bg-emerald-600 px-3 py-2 text-sm font-medium hover:bg-emerald-500"
            >
              Sign in to approve
            </button>
          ) : null}

          {session ? (
            <p className="text-xs text-zinc-500">
              Signed in as {(session.user as { email?: string })?.email || "user"}
            </p>
          ) : null}

          {lookup?.status === "pending" && requirements ? (
            <div className="space-y-3 rounded-lg border border-emerald-500/20 bg-emerald-500/5 p-4 text-sm">
              <p>
                <span className="text-zinc-400">Amount:</span>{" "}
                <span className="font-mono">
                  {formatUsdc(requirements.amount)} USDC
                </span>
              </p>
              <p className="break-all">
                <span className="text-zinc-400">Pay to:</span>{" "}
                <span className="font-mono text-xs">{requirements.payTo}</span>
              </p>
              <p>
                <span className="text-zinc-400">Network:</span>{" "}
                <span className="font-mono">{requirements.network}</span>
              </p>
              <label className="block">
                <span className="text-zinc-400">
                  Signed PaymentPayload (JSON from Wallet Kit / EIP-712 signer)
                </span>
                <textarea
                  value={signedPayloadJson}
                  onChange={(e) => setSignedPayloadJson(e.target.value)}
                  rows={10}
                  className="mt-1 w-full rounded-md border border-zinc-700 bg-zinc-950 px-3 py-2 font-mono text-xs"
                  placeholder='{"x402Version":2,"scheme":"exact",...}'
                />
              </label>
              <div className="flex gap-2">
                <button
                  type="button"
                  disabled={!canApprove || busy}
                  onClick={() => void submit("approve")}
                  className="flex-1 rounded-md bg-emerald-600 px-3 py-2 text-sm font-medium disabled:opacity-50"
                >
                  Approve payment
                </button>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void submit("deny")}
                  className="rounded-md border border-zinc-600 px-3 py-2 text-sm"
                >
                  Deny
                </button>
              </div>
            </div>
          ) : null}

          {lookup && lookup.status !== "pending" ? (
            <p className="text-sm text-zinc-300">
              Status: <span className="font-mono">{lookup.status}</span>
            </p>
          ) : null}

          {error ? <p className="text-sm text-red-400">{error}</p> : null}
          {done ? (
            <p className="text-sm text-emerald-400">
              Done: {done}. You can close this window.
            </p>
          ) : null}
        </div>
      </div>
    </div>
  );
}
