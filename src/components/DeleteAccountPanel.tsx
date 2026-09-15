"use client";

import { AuthState, ClientState, useTurnkey } from "@turnkey/react-wallet-kit";
import { signOut } from "next-auth/react";
import { useEffect, useState } from "react";
import { isTurnkeyWalletConfigured } from "@/lib/turnkey-wallet-config";

type Eligibility = {
  ownsApps: boolean;
  hasCredits: boolean;
  appCount: number;
  creditText: string | null;
};

async function ignoreMissingSubOrg(
  deleteSubOrganization: (input: { deleteWithoutExport: boolean }) => Promise<unknown>,
): Promise<void> {
  try {
    await deleteSubOrganization({ deleteWithoutExport: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (!/not found|already|does not exist/i.test(message)) {
      throw err;
    }
  }
}

function deletionConsequence(eligibility: Eligibility | null): string {
  if (eligibility?.ownsApps) {
    return "I understand this does not delete my apps. Support must finish app data erasure.";
  }
  if (eligibility?.hasCredits && eligibility.creditText) {
    return `I understand ${eligibility.creditText} in prepaid credits on this login will be forfeited.`;
  }
  return "I understand any prepaid credits on this login are forfeited.";
}

function DeleteAccountPanelInner() {
  const { authState, clientState, deleteSubOrganization } = useTurnkey();
  const [eligibility, setEligibility] = useState<Eligibility | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [confirmLogin, setConfirmLogin] = useState(false);
  const [confirmConsequence, setConfirmConsequence] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [handedOff, setHandedOff] = useState(false);

  const sessionReady =
    clientState === ClientState.Ready && authState === AuthState.Authenticated;

  useEffect(() => {
    let cancelled = false;
    fetch("/api/v1/me/account/deletion-eligibility")
      .then(async (res) => {
        if (!res.ok) {
          throw new Error("Could not load account deletion details.");
        }
        return (await res.json()) as Eligibility;
      })
      .then((data) => {
        if (!cancelled) setEligibility(data);
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setLoadError(
            err instanceof Error ? err.message : "Could not load account details.",
          );
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const canSubmit = Boolean(
    sessionReady && eligibility && confirmLogin && confirmConsequence && !busy,
  );

  const deleteAccount = async () => {
    if (!canSubmit || !eligibility) return;
    setBusy(true);
    setError(null);
    try {
      await ignoreMissingSubOrg(deleteSubOrganization);

      const res = await fetch("/api/v1/me/account", { method: "DELETE" });
      const data = (await res.json().catch(() => ({}))) as {
        deleted?: boolean;
        handedOff?: boolean;
        error?: string;
      };
      if (!res.ok) {
        throw new Error(data.error || "Could not delete this PymtHouse account.");
      }
      if (data.handedOff) {
        setHandedOff(true);
        return;
      }
      await signOut({ callbackUrl: "/login" });
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Could not delete this account.",
      );
    } finally {
      setBusy(false);
    }
  };

  const consequence = deletionConsequence(eligibility);

  return (
    <section className="rounded-md border border-red-500/20 bg-red-500/5">
      <div className="border-b border-red-500/20 px-4 py-3.5">
        <h2 className="text-sm font-medium text-zinc-100">Delete this account</h2>
        <p className="mt-1 text-sm text-zinc-500">
          Permanently deletes the Turnkey sub-organization you are signed into,
          including its embedded wallet. App ownership is not destroyed here.
        </p>
      </div>
      <div className="space-y-3 px-4 py-3.5">
        {!sessionReady ? (
          <p className="text-sm text-zinc-500">
            Sign in again on this device. Deleting a sub-organization has to be
            stamped by your live Turnkey session.
          </p>
        ) : null}
        {loadError ? (
          <p className="text-sm text-red-400">{loadError}</p>
        ) : null}
        {eligibility?.ownsApps ? (
          <p className="text-sm text-amber-300">
            This login owns {eligibility.appCount}{" "}
            {eligibility.appCount === 1 ? "app" : "apps"}. Deleting it removes
            the invalid sub-org and login only. Apps stay; ask support to finish
            data erasure or reassign ownership.
          </p>
        ) : null}
        {eligibility?.hasCredits && eligibility.creditText ? (
          <p className="text-sm text-amber-300">
            This login has {eligibility.creditText} in prepaid credits. Those
            credits cannot be moved to another account.
          </p>
        ) : null}
        {handedOff ? (
          <p className="text-sm text-emerald-400">
            The Turnkey sub-organization was removed. This PymtHouse row still
            owns apps — contact support to finish erasure or reassign those apps.
          </p>
        ) : (
          <>
            <label className="flex items-start gap-2 text-sm text-zinc-300">
              <input
                type="checkbox"
                className="mt-1"
                checked={confirmLogin}
                onChange={(event) => setConfirmLogin(event.target.checked)}
              />
              <span>
                I understand this permanently deletes this login and its wallet.
              </span>
            </label>
            <label className="flex items-start gap-2 text-sm text-zinc-300">
              <input
                type="checkbox"
                className="mt-1"
                checked={confirmConsequence}
                onChange={(event) => setConfirmConsequence(event.target.checked)}
              />
              <span>{consequence}</span>
            </label>
            <button
              type="button"
              disabled={!canSubmit}
              onClick={() => {
                void deleteAccount();
              }}
              className="inline-flex h-[30px] items-center justify-center rounded-lg border border-red-500/40 px-3 text-xs font-medium text-red-300 transition-colors hover:border-red-400 hover:bg-red-500/10 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {busy ? "Deleting…" : "Delete this account"}
            </button>
          </>
        )}
        {error ? <p className="text-xs text-red-400">{error}</p> : null}
      </div>
    </section>
  );
}

export function DeleteAccountPanel() {
  if (!isTurnkeyWalletConfigured()) {
    return (
      <section className="rounded-md border border-zinc-800 bg-zinc-900/40 px-4 py-3.5">
        <h2 className="text-sm font-medium text-zinc-100">Delete this account</h2>
        <p className="mt-2 text-sm text-zinc-500">
          Turnkey Wallet Kit is not configured in this environment.
        </p>
      </section>
    );
  }

  return <DeleteAccountPanelInner />;
}
