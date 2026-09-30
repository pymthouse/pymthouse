"use client";

import { useEffect, useState } from "react";

import type { TurnkeyBridgeSession } from "@/lib/turnkey-nextauth-bridge";

export type AccountSessionBindingState =
  | { status: "idle"; error: null }
  | { status: "checking"; error: null }
  | { status: "bound"; error: null }
  | { status: "unbound"; error: string };

type GetTurnkeySession = () => Promise<TurnkeyBridgeSession>;

export function accountSessionBindingMessage(
  turnkeySessionReady: boolean,
  state: AccountSessionBindingState,
): string {
  if (!turnkeySessionReady) {
    return "Sign in again on this device. Account changes require a live Turnkey session.";
  }
  if (state.status === "unbound") return state.error;
  return "Verifying that this wallet belongs to your signed-in PymtHouse account…";
}

export async function requireAccountSessionBinding(
  getSession: GetTurnkeySession,
): Promise<void> {
  const session = await getSession();
  const turnkeySessionJwt = session?.token?.trim();
  if (!turnkeySessionJwt) {
    throw new Error("A live Turnkey session is required.");
  }

  const response = await fetch("/api/v1/me/account/session-binding", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ turnkeySessionJwt }),
  });
  if (response.ok) return;

  const data = (await response.json().catch(() => ({}))) as {
    error?: string;
  };
  throw new Error(
    data.error ||
      "Could not verify that this wallet belongs to your PymtHouse account.",
  );
}

export function useAccountSessionBinding(
  enabled: boolean,
  getSession: GetTurnkeySession,
): AccountSessionBindingState {
  const [state, setState] = useState<AccountSessionBindingState>({
    status: "idle",
    error: null,
  });

  useEffect(() => {
    let cancelled = false;
    if (!enabled) {
      setState({ status: "idle", error: null });
      return () => {
        cancelled = true;
      };
    }

    setState({ status: "checking", error: null });
    requireAccountSessionBinding(getSession)
      .then(() => {
        if (!cancelled) setState({ status: "bound", error: null });
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        setState({
          status: "unbound",
          error:
            error instanceof Error
              ? error.message
              : "Could not verify this wallet session.",
        });
      });

    return () => {
      cancelled = true;
    };
  }, [enabled, getSession]);

  return state;
}
