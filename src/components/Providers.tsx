"use client";

import { SessionProvider } from "next-auth/react";
import type { Session } from "next-auth";
import { createContext, useContext } from "react";
import TurnkeyProviderWrapper from "./TurnkeyProvider";

const TurnkeyBackendAuthContext = createContext(false);

export function useTurnkeyBackendAuth(): boolean {
  return useContext(TurnkeyBackendAuthContext);
}

export default function Providers({
  children,
  session,
  backendAuth = false,
}: Readonly<{
  children: React.ReactNode;
  session: Session | null;
  backendAuth?: boolean;
}>) {
  return (
    // `null` must never reach SessionProvider: next-auth v4 pins it as the
    // session for the tab's whole SPA lifetime and then refuses every refetch
    // (`_session === null` early-returns in _getSession, and update() no-ops),
    // so a tab loaded while signed out stays "unauthenticated" on the client
    // even after the cookie becomes valid. `undefined` means "unknown", which
    // makes the provider fetch /api/auth/session on mount. A real session is
    // still passed through so signed-in loads render without a loading pass.
    <SessionProvider session={session ?? undefined} refetchOnWindowFocus={false}>
      <TurnkeyBackendAuthContext.Provider value={backendAuth}>
        <TurnkeyProviderWrapper backendAuth={backendAuth}>{children}</TurnkeyProviderWrapper>
      </TurnkeyBackendAuthContext.Provider>
    </SessionProvider>
  );
}
