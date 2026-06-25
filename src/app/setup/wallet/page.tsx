import { Suspense } from "react";
import { getServerSession } from "next-auth";
import { redirect } from "next/navigation";
import { authOptions } from "@/lib/next-auth-options";
import { db } from "@/db/index";
import { users } from "@/db/schema";
import { eq } from "drizzle-orm";
import { WalletSetupClient } from "./WalletSetupClient";

export default async function WalletSetupPage({
  searchParams,
}: {
  searchParams: Promise<{ to?: string }>;
}) {
  const session = await getServerSession(authOptions);
  const params = await searchParams;
  const destination =
    typeof params.to === "string" &&
    params.to.startsWith("/") &&
    !params.to.startsWith("//")
      ? params.to
      : "/dashboard";

  if (!session?.user) {
    const loginUrl = `/login?callbackUrl=${encodeURIComponent(`/setup/wallet?to=${encodeURIComponent(destination)}`)}`;
    redirect(loginUrl);
  }

  const sessionUser = session.user as Record<string, unknown>;
  const userId = sessionUser.id as string | undefined;

  if (userId) {
    const rows = await db.select().from(users).where(eq(users.id, userId)).limit(1);
    if (rows[0]?.walletAddress) {
      redirect(destination);
    }
  }

  return (
    <div className="flex items-center justify-center min-h-screen bg-zinc-950">
      <div className="w-full max-w-sm">
        <div className="text-center mb-8">
          <h1 className="text-3xl font-bold tracking-tight">
            <span className="text-emerald-400">pymt</span>house
          </h1>
          <p className="text-zinc-500 mt-2 text-sm">Identity & Payment Infrastructure</p>
        </div>

        <div className="border border-zinc-800 rounded-xl p-6 bg-zinc-900/30">
          <h2 className="text-lg font-semibold text-zinc-200 mb-1">
            One more step
          </h2>
          <p className="text-sm text-zinc-500 mb-5">
            Create your Turnkey wallet to complete account setup. This gives you
            a non-custodial crypto wallet tied to your account.
          </p>
          <Suspense
            fallback={
              <div className="animate-pulse text-zinc-500 text-sm text-center py-3">
                Loading wallet kit...
              </div>
            }
          >
            <WalletSetupClient destination={destination} />
          </Suspense>
        </div>
      </div>
    </div>
  );
}
