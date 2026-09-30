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
  backendAuth = false,
  email = null,
}: Readonly<{
  noticeEmail: string | null;
  backendAuth?: boolean;
  email?: string | null;
}>) {
  if (backendAuth) {
    return (
      <>
        <WalletAccountPanel email={email} />
        <DeleteAccountPanel />
      </>
    );
  }
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

function WalletAccountPanel({ email }: Readonly<{ email: string | null }>) {
  const { handleAddPasskey, handleRemovePasskey, refreshUser, user } = useTurnkey();
  const authenticators = user?.authenticators ?? [];
  return (
    <section className="space-y-4 rounded-md border border-zinc-800 bg-zinc-900/40 px-4 py-4">
      <div>
        <h2 className="text-sm font-medium text-zinc-100">Email</h2>
        <p className="mt-2 text-sm text-zinc-300">{email || "No verified email"}</p>
        <p className="mt-3 text-sm text-zinc-500">
          Any Google, GitHub, or Discord account that uses this email signs in
          to this wallet.
        </p>
      </div>
      <div>
        <h2 className="text-sm font-medium text-zinc-100">Passkeys</h2>
        <ul className="mt-2 space-y-2">
          {authenticators.length === 0 ? (
            <li className="text-sm text-zinc-500">No passkeys on this wallet.</li>
          ) : (
            authenticators.map((authenticator) => (
              <li
                key={authenticator.authenticatorId}
                className="flex items-center justify-between gap-3 text-sm text-zinc-300"
              >
                <span>{authenticator.authenticatorName || "Passkey"}</span>
                <button
                  type="button"
                  className="text-xs text-zinc-400 hover:text-zinc-100"
                  onClick={() => {
                    void handleRemovePasskey({
                      authenticatorId: authenticator.authenticatorId,
                    }).then(() => refreshUser());
                  }}
                >
                  Remove
                </button>
              </li>
            ))
          )}
        </ul>
        <button
          type="button"
          className="mt-3 rounded-lg border border-zinc-700 px-3 py-1.5 text-xs text-zinc-200 hover:border-zinc-500"
          onClick={() => {
            void handleAddPasskey({ name: "PymtHouse passkey" }).then(() => refreshUser());
          }}
        >
          Add passkey
        </button>
      </div>
    </section>
  );
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
