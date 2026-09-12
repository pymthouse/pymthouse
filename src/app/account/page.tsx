export const dynamic = "force-dynamic";

import { getServerSession } from "next-auth";
import { redirect } from "next/navigation";
import { Suspense } from "react";
import DashboardLayout from "@/components/DashboardLayout";
import { DeleteAccountPanel } from "@/components/DeleteAccountPanel";
import { SignInMethodsPanel } from "@/components/SignInMethodsPanel";
import { authOptions } from "@/lib/next-auth-options";

export default async function AccountPage() {
  const session = await getServerSession(authOptions);
  if (!session) redirect("/login");

  return (
    <DashboardLayout>
      <div className="space-y-6">
        <div>
          <h1 className="text-2xl font-bold text-zinc-100">Account</h1>
          <p className="mt-1 text-sm text-zinc-500">
            Sign-in methods for the wallet that owns this PymtHouse account.
          </p>
        </div>
        <Suspense
          fallback={
            <div className="rounded-md border border-zinc-800 bg-zinc-900/40 px-4 py-6 text-sm text-zinc-500">
              Loading sign-in methods…
            </div>
          }
        >
          <SignInMethodsPanel />
          <DeleteAccountPanel />
        </Suspense>
      </div>
    </DashboardLayout>
  );
}
