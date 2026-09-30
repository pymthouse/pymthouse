"use client";

import { AuthState, ClientState, useTurnkey } from "@turnkey/react-wallet-kit";
import { useEffect, useRef } from "react";

import { DeleteAccountPanel } from "@/components/DeleteAccountPanel";
import { SignInMethodsPanel } from "@/components/SignInMethodsPanel";
import {
  accountSessionBindingMessage,
  useAccountSessionBinding,
} from "@/lib/account-session-binding-client";
import { isTurnkeyWalletConfigured } from "@/lib/turnkey-wallet-config";

export function AccountManagementPanels({
  noticeEmail,
}: Readonly<{ noticeEmail: string | null }>) {
  if (!isTurnkeyWalletConfigured()) {
    return (
      <>
        <SignInMethodsPanel noticeEmail={noticeEmail} />
        <DeleteAccountPanel />
      </>
    );
  }
  return <BoundAccountManagementPanels noticeEmail={noticeEmail} />;
}

function BoundAccountManagementPanels({
  noticeEmail,
}: Readonly<{ noticeEmail: string | null }>) {
  const { authState, clientState, getSession, logout } = useTurnkey();
  const staleSessionCleared = useRef(false);
  const turnkeySessionReady =
    clientState === ClientState.Ready && authState === AuthState.Authenticated;
  const binding = useAccountSessionBinding(turnkeySessionReady, getSession);

  useEffect(() => {
    if (binding.status !== "unbound" || staleSessionCleared.current) return;
    staleSessionCleared.current = true;
    void logout().catch(() => undefined);
  }, [binding.status, logout]);

  if (binding.status !== "bound") {
    return (
      <section className="rounded-md border border-amber-500/20 bg-amber-500/5 px-4 py-3.5">
        <h2 className="text-sm font-medium text-zinc-100">
          Verify this account&apos;s wallet
        </h2>
        <p className="mt-2 text-sm text-amber-200">
          {accountSessionBindingMessage(turnkeySessionReady, binding)}
        </p>
        {binding.status === "unbound" ? (
          <p className="mt-2 text-xs text-zinc-500">
            The stale wallet session was cleared. Sign out of PymtHouse, then
            sign in with email OTP for the old account you want to recover.
          </p>
        ) : null}
      </section>
    );
  }

  return (
    <>
      <SignInMethodsPanel noticeEmail={noticeEmail} />
      <DeleteAccountPanel />
    </>
  );
}
