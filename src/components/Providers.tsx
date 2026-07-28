"use client";

import { SessionProvider } from "next-auth/react";
import type { Session } from "next-auth";
import TurnkeyProviderWrapper from "./TurnkeyProvider";

export default function Providers({
  children,
  session,
}: Readonly<{
  children: React.ReactNode;
  session: Session | null;
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
      <TurnkeyProviderWrapper>{children}</TurnkeyProviderWrapper>
    </SessionProvider>
  );
}
