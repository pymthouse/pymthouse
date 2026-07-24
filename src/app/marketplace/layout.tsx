"use client";

import { useSession } from "next-auth/react";
import DashboardLayout from "@/components/DashboardLayout";
import { MarketplaceLayoutProvider } from "@/context/MarketplaceLayoutContext";

export default function MarketplaceLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  const { data: session, status } = useSession();

  if (status === "loading") {
    return (
      <div className="flex min-h-screen items-center justify-center bg-zinc-950 text-zinc-500">
        <div className="animate-pulse">Loading...</div>
      </div>
    );
  }

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
