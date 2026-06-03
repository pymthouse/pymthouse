"use client";

import { SessionProvider } from "next-auth/react";
import type { Session } from "next-auth";
import TurnkeyProviderWrapper from "./TurnkeyProvider";

export default function Providers({
  children,
  session,
}: {
  children: React.ReactNode;
  session: Session | null;
}) {
  return (
    <SessionProvider session={session}>
      <TurnkeyProviderWrapper>{children}</TurnkeyProviderWrapper>
    </SessionProvider>
  );
}
