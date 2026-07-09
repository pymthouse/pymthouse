export const dynamic = "force-dynamic";

import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/next-auth-options";
import { redirect } from "next/navigation";
import { db } from "@/db/index";
import { signerConfig, transactions } from "@/db/schema";
import { eq } from "drizzle-orm";
import { listUserAccessibleApps } from "@/lib/user-apps";
import { getDashboardUsageSummary } from "@/lib/dashboard-usage-summary";
import MyAppsSection from "@/components/apps/MyAppsSection";
import AdminDashboardOverview, { type AdminStatCard } from "@/components/AdminDashboardOverview";
import DashboardUsagePanel from "@/components/DashboardUsagePanel";
import { syncSignerStatus } from "@/lib/signer-proxy";

function formatWei(wei: string): string {
  if (wei === "0") return "0 ETH";
  const value = BigInt(wei);
  const eth = Number(value) / 1e18;
  if (eth < 0.001) return `${wei} wei`;
  return `${eth.toFixed(6)} ETH`;
}

export default async function DashboardPage() {
  const session = await getServerSession(authOptions);
  if (!session) redirect("/");

  const role = (session.user as Record<string, unknown>)?.role as string;
  const userId = (session.user as Record<string, unknown>)?.id as string;

  if (role === "admin" || role === "operator") {
    return <AdminDashboard userId={userId} />;
  }

  return <DeveloperDashboard userId={userId} />;
}

async function AdminDashboard({ userId }: Readonly<{ userId: string }>) {
  await syncSignerStatus();

  const [myApps, initialUsage, signerRows, allTransactions] = await Promise.all([
    userId ? listUserAccessibleApps(userId) : Promise.resolve([]),
    getDashboardUsageSummary(true),
    db.select().from(signerConfig).where(eq(signerConfig.id, "default")).limit(1),
    db.select({ amountWei: transactions.amountWei }).from(transactions),
  ]);
  const signer = signerRows[0];
  const signerOnline = signer?.status === "running";
  let signerDetail = "no address";
  if (signer?.ethAddress) {
    signerDetail = `${signer.ethAddress.slice(0, 6)}...${signer.ethAddress.slice(-4)}`;
  } else if (signerOnline) {
    signerDetail = "connected";
  } else if (signer?.status) {
    signerDetail = signer.status;
  }

  let totalFeeWei = 0n;
  for (const txn of allTransactions) {
    totalFeeWei += BigInt(txn.amountWei);
  }

  const volumeStat: AdminStatCard = {
    label: "Total Volume",
    value: formatWei(totalFeeWei.toString()),
    sub: `${allTransactions.length} transactions`,
  };

  return (
    <>
      <div className="mb-8 flex items-end justify-between">
        <div>
          <h2 className="text-2xl font-bold tracking-tight">Dashboard</h2>
          <p className="text-zinc-500 mt-1">Platform overview</p>
        </div>
        <div
          className={`flex items-center gap-2 text-xs font-medium ${
            signerOnline ? "text-emerald-400" : "text-zinc-500"
          }`}
          title={`Signer ${signerOnline ? "Online" : signer?.status || "offline"} · ${signerDetail}`}
        >
          <span className="relative flex h-2 w-2">
            {signerOnline && (
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75" />
            )}
            <span
              className={`relative inline-flex rounded-full h-2 w-2 ${
                signerOnline ? "bg-emerald-500" : "bg-zinc-600"
              }`}
            />
          </span>
          {signerOnline ? "Network live" : "Network offline"}
        </div>
      </div>

      <AdminDashboardOverview
        myApps={myApps}
        initialUsage={initialUsage}
        volumeStat={volumeStat}
      />
    </>
  );
}

async function DeveloperDashboard({ userId }: Readonly<{ userId: string }>) {
  const apps = userId ? await listUserAccessibleApps(userId) : [];

  return (
    <>
      <div className="mb-8">
        <h2 className="text-2xl font-bold tracking-tight">Dashboard</h2>
        <p className="text-zinc-500 mt-1">Developer overview</p>
      </div>

      <MyAppsSection apps={apps} />

      <div className="mt-6">
        <DashboardUsagePanel />
      </div>

      <div className="mt-6">
        <DocumentationCard />
      </div>
    </>
  );
}

function DocumentationCard() {
  return (
    <div className="rounded-xl border border-white/[0.06] bg-white/[0.02] backdrop-blur-sm p-6">
      <div className="w-9 h-9 rounded-xl bg-zinc-800/60 flex items-center justify-center mb-4">
        <svg className="w-5 h-5 text-zinc-400" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M12 6.253v13m0-13C10.832 5.477 9.246 5 7.5 5S4.168 5.477 3 6.253v13C4.168 18.477 5.754 18 7.5 18s3.332.477 4.5 1.253m0-13C13.168 5.477 14.754 5 16.5 5c1.747 0 3.332.477 4.5 1.253v13C19.832 18.477 18.247 18 16.5 18c-1.746 0-3.332.477-4.5 1.253" />
        </svg>
      </div>
      <h3 className="font-semibold text-zinc-100 mb-1.5">Documentation</h3>
      <p className="text-sm text-zinc-500 mb-5 leading-relaxed">
        Integrate OIDC authentication and payment flows into your
        application.
      </p>
      <div className="flex flex-col gap-2 mb-4">
        <a
          href="https://docs.pymthouse.com"
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-2 px-4 py-2 bg-zinc-800/40 text-zinc-300 border border-zinc-700/60 rounded-lg text-sm font-medium hover:bg-zinc-800 hover:text-zinc-100 transition-colors"
        >
          <svg className="w-4 h-4 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M12 6.253v13m0-13C10.832 5.477 9.246 5 7.5 5S4.168 5.477 3 6.253v13C4.168 18.477 5.754 18 7.5 18s3.332.477 4.5 1.253m0-13C13.168 5.477 14.754 5 16.5 5c1.747 0 3.332.477 4.5 1.253v13C19.832 18.477 18.247 18 16.5 18c-1.746 0-3.332.477-4.5 1.253" />
          </svg>
          Docs
          <svg className="w-3 h-3 ml-auto opacity-40" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
          </svg>
        </a>
        <a
          href="https://pymthouse.com/api/v1/docs"
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-2 px-4 py-2 bg-emerald-500/8 text-emerald-400 border border-emerald-500/25 rounded-lg text-sm font-medium hover:bg-emerald-500/15 transition-colors"
        >
          <svg className="w-4 h-4 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M10 20l4-16m4 4l4 4-4 4M6 16l-4-4 4-4" />
          </svg>
          API Reference
          <svg className="w-3 h-3 ml-auto opacity-40" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
          </svg>
        </a>
      </div>
      <div className="text-xs text-zinc-600">
        Discovery:{" "}
        <code className="text-zinc-500">/.well-known/openid-configuration</code>
      </div>
    </div>
  );
}
