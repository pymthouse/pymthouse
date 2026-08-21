"use client";

import { useSession } from "next-auth/react";
import DashboardLayout from "@/components/DashboardLayout";
import { MarketplaceLayoutProvider } from "@/context/MarketplaceLayoutContext";

export default function MarketplaceLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  const { data: session } = useSession();

  // No loading gate: signed-in requests get their session from the server on
  // first paint, so only anonymous visitors ever see an unresolved session —
  // and the public layout is already the right answer for them. Blocking on
  // `status === "loading"` would put a spinner in front of a public page.
  if (session?.user) {
    return (
      <MarketplaceLayoutProvider insideDashboard>
        <DashboardLayout>{children}</DashboardLayout>
      </MarketplaceLayoutProvider>
    );
  }

  return (
    <MarketplaceLayoutProvider insideDashboard={false}>
      {children}
    </MarketplaceLayoutProvider>
  );
}
