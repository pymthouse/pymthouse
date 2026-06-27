export const dynamic = "force-dynamic";

import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/next-auth-options";
import { redirect } from "next/navigation";
import { db } from "@/db/index";
import { signerConfig, transactions, endUsers } from "@/db/schema";
import { eq } from "drizzle-orm";
import Link from "next/link";
import AppStatusBadge from "@/components/apps/AppStatusBadge";
import { listUserAccessibleApps, type UserAppSummary } from "@/lib/user-apps";
import {
  ACTIVE_STREAM_PAYMENT_WINDOW_LABEL,
  countActiveStreamsByRecentPayment,
  getActiveStreamSessionsByRecentPayment,
} from "@/lib/active-streams";
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
    return <AdminDashboard />;
  }

  return <DeveloperDashboard userId={userId} />;
}

async function AdminDashboard() {
  await syncSignerStatus();

  const signerRows = await db
    .select()
    .from(signerConfig)
    .where(eq(signerConfig.id, "default"))
    .limit(1);
  const signer = signerRows[0];

  const signerOnline = signer?.status === "running";
  let signerSub = "no address";
  if (signer?.ethAddress) {
    signerSub = `${signer.ethAddress.slice(0, 6)}...${signer.ethAddress.slice(-4)}`;
  } else if (signerOnline) {
    signerSub = "connected";
  }

  const [activeStreamCount, recentActiveSessions, allTransactions, allEndUsers] =
    await Promise.all([
      countActiveStreamsByRecentPayment(),
      getActiveStreamSessionsByRecentPayment(5),
      db
        .select({
          amountWei: transactions.amountWei,
          platformCutWei: transactions.platformCutWei,
        })
        .from(transactions),
      db.select().from(endUsers),
    ]);

  let totalFeeWei = 0n;
  let totalPlatformCutWei = 0n;
  for (const txn of allTransactions) {
    totalFeeWei += BigInt(txn.amountWei);
    totalPlatformCutWei += BigInt(txn.platformCutWei || "0");
  }

  const stats = [
    {
      label: "Signer",
      value: signerOnline ? "Online" : signer?.status || "N/A",
      sub: signerSub,
      color: signerOnline ? "text-emerald-400" : "text-zinc-400",
      glow: signerOnline
        ? "border-emerald-500/20 shadow-[inset_0_1px_0_rgba(52,211,153,0.06)]"
        : "border-white/[0.06]",
      live: signerOnline,
    },
    {
      label: "Active Streams",
      value: activeStreamCount.toString(),
      sub: ACTIVE_STREAM_PAYMENT_WINDOW_LABEL,
      color: "text-blue-400",
      glow: "border-blue-500/20 shadow-[inset_0_1px_0_rgba(96,165,250,0.06)]",
      live: activeStreamCount > 0,
    },
    {
      label: "App Users",
      value: allEndUsers.length.toString(),
      sub: `${allEndUsers.filter((u) => u.isActive).length} active`,
      color: "text-cyan-400",
      glow: "border-cyan-500/15 shadow-[inset_0_1px_0_rgba(34,211,238,0.05)]",
      live: false,
    },
    {
      label: "Total Volume",
      value: formatWei(totalFeeWei.toString()),
      sub: `${allTransactions.length} transactions`,
      color: "text-amber-400",
      glow: "border-amber-500/15 shadow-[inset_0_1px_0_rgba(251,191,36,0.05)]",
      live: false,
    },
    {
      label: "Platform Revenue",
      value: formatWei(totalPlatformCutWei.toString()),
      sub: "total cut earned",
      color: "text-purple-400",
      glow: "border-purple-500/15 shadow-[inset_0_1px_0_rgba(167,139,250,0.05)]",
      live: false,
    },
  ];

  return (
    <>
      <div className="mb-8 flex items-end justify-between">
        <div>
          <h2 className="text-2xl font-bold tracking-tight">Dashboard</h2>
          <p className="text-zinc-500 mt-1">Platform overview</p>
        </div>
        {signerOnline && (
          <div className="flex items-center gap-2 text-xs text-emerald-400 font-medium">
            <span className="relative flex h-2 w-2">
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75" />
              <span className="relative inline-flex rounded-full h-2 w-2 bg-emerald-500" />
            </span>
            {" "}
            Network live
          </div>
        )}
      </div>

      <FreeUsageBanner />

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-4 mb-8">
        {stats.map((stat) => (
          <div
            key={stat.label}
            className={`relative overflow-hidden rounded-xl border bg-white/[0.02] backdrop-blur-sm p-5 transition-colors hover:bg-white/[0.035] ${stat.glow}`}
          >
            <div className="flex items-center justify-between mb-3">
              <p className="text-[11px] font-semibold text-zinc-500 uppercase tracking-widest">
                {stat.label}
              </p>
              {stat.live && (
                <span className="relative flex h-1.5 w-1.5">
                  <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-60" />
                  <span className="relative inline-flex rounded-full h-1.5 w-1.5 bg-emerald-500" />
                </span>
              )}
            </div>
            <p className={`text-2xl font-bold tabular-nums leading-none ${stat.color}`}>
              {stat.value}
            </p>
            <p className="text-xs text-zinc-600 mt-2 leading-snug">{stat.sub}</p>
          </div>
        ))}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <div className="rounded-xl border border-white/[0.06] bg-white/[0.02] backdrop-blur-sm p-5">
          <h3 className="font-semibold text-zinc-200 mb-4">App Users</h3>
          {allEndUsers.length === 0 ? (
            <p className="text-zinc-500 text-sm">
              No app users yet. Create one from the Users page.
            </p>
          ) : (
            <div className="divide-y divide-zinc-800/60">
              {allEndUsers.slice(0, 5).map((user) => (
                <div
                  key={user.id}
                  className="flex items-center justify-between py-2.5 first:pt-0 last:pb-0 text-sm"
                >
                  <div className="flex items-center gap-2.5">
                    <span
                      className={`w-1.5 h-1.5 rounded-full shrink-0 ${
                        user.isActive ? "bg-emerald-400" : "bg-zinc-600"
                      }`}
                    />
                    <span className="text-zinc-300">
                      {user.name || user.email || user.id.slice(0, 8)}
                    </span>
                  </div>
                  <span className="text-zinc-500 text-xs font-mono">
                    {user.externalUserId || user.id.slice(0, 8)}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="rounded-xl border border-white/[0.06] bg-white/[0.02] backdrop-blur-sm p-5">
          <div className="flex items-center justify-between mb-4">
            <h3 className="font-semibold text-zinc-200">Recent Streams</h3>
            {activeStreamCount > 0 && (
              <span className="flex items-center gap-1.5 text-xs text-blue-400 font-medium">
                <span className="relative flex h-1.5 w-1.5">
                  <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-blue-400 opacity-60" />
                  <span className="relative inline-flex rounded-full h-1.5 w-1.5 bg-blue-500" />
                </span>
                {" "}
                Live
              </span>
            )}
          </div>
          {recentActiveSessions.length === 0 ? (
            <p className="text-zinc-500 text-sm">No active streams</p>
          ) : (
            <div className="divide-y divide-zinc-800/60">
              {recentActiveSessions.map((session) => (
                <div
                  key={session.id}
                  className="flex items-center justify-between py-2.5 first:pt-0 last:pb-0 text-sm"
                >
                  <span className="text-zinc-300 font-mono text-xs">
                    {session.manifestId.length > 16
                      ? `${session.manifestId.slice(0, 12)}…`
                      : session.manifestId}
                  </span>
                  <span className="text-emerald-400/80 text-xs font-mono tabular-nums">
                    {formatWei(session.totalFeeWei)}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </>
  );
}

function FreeUsageBanner() {
  return (
    <div className="mb-6 flex items-start gap-3 p-4 rounded-xl border border-teal-500/15 bg-teal-500/[0.04] backdrop-blur-sm">
      <div className="shrink-0 mt-0.5 w-7 h-7 rounded-lg bg-teal-500/10 flex items-center justify-center">
        <svg
          className="w-4 h-4 text-teal-400"
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
          aria-hidden="true"
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={1.5}
            d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"
          />
        </svg>
      </div>
      <div>
        <p className="text-sm font-semibold text-teal-300">
          $5 free credit during beta
        </p>
        <p className="text-xs text-zinc-400 mt-0.5 leading-relaxed">
          Users get $5 of free credit per month during beta. Usage is tracked via
          signing requests.
        </p>
      </div>
    </div>
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

      <FreeUsageBanner />

      <MyAppsSection apps={apps} />

      <div className="mt-6">
        <DocumentationCard />
      </div>
    </>
  );
}

function myAppsSummaryText(appCount: number): string {
  if (appCount === 0) {
    return "Create an app to configure identity, plans, and payments.";
  }
  const noun = appCount === 1 ? "app" : "apps";
  return `${appCount} ${noun} — open settings or usage from here.`;
}

function appListSecondaryLine(app: UserAppSummary): string | null {
  if (app.subtitle) {
    return app.subtitle;
  }
  if (app.clientId) {
    return app.clientId;
  }
  return null;
}

function AppListSecondaryLine({ app }: Readonly<{ app: UserAppSummary }>) {
  const secondaryLine = appListSecondaryLine(app);
  if (!secondaryLine) {
    return null;
  }
  return (
    <p
      className={`text-xs mt-0.5 truncate ${
        app.subtitle ? "text-zinc-500" : "font-mono text-zinc-600"
      }`}
    >
      {secondaryLine}
    </p>
  );
}

function MyAppsSection({ apps }: Readonly<{ apps: UserAppSummary[] }>) {
  return (
    <section className="rounded-xl border border-emerald-500/15 bg-white/[0.02] backdrop-blur-sm shadow-[inset_0_1px_0_rgba(52,211,153,0.06)]">
      <div className="flex flex-col gap-3 border-b border-white/[0.06] px-5 py-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h3 className="font-semibold text-zinc-100">My Apps</h3>
          <p className="text-sm text-zinc-500 mt-0.5">
            {myAppsSummaryText(apps.length)}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2 shrink-0">
          {apps.length > 0 && (
            <Link
              href="/apps"
              className="px-3 py-1.5 text-sm font-medium text-zinc-400 hover:text-zinc-200 transition-colors"
            >
              View all
            </Link>
          )}
          <Link
            href="/apps/new"
            className="inline-flex items-center gap-1.5 px-4 py-2 bg-emerald-600 text-white rounded-lg text-sm font-medium hover:bg-emerald-500 transition-colors"
          >
            Create app
          </Link>
        </div>
      </div>

      {apps.length === 0 ? (
        <div className="px-5 py-10 text-center">
          <div className="w-12 h-12 bg-zinc-800/80 rounded-xl flex items-center justify-center mx-auto mb-3">
            <svg
              className="w-6 h-6 text-zinc-600"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
              aria-hidden="true"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={1.5}
                d="M20 7l-8-4-8 4m16 0l-8 4m8-4v10l-8 4m0-10L4 7m8 4v10M4 7v10l8 4"
              />
            </svg>
          </div>
          <p className="text-sm text-zinc-400 mb-4">No apps yet.</p>
          <Link
            href="/apps/new"
            className="inline-flex px-4 py-2 bg-emerald-500/10 text-emerald-400 border border-emerald-500/25 rounded-lg text-sm font-medium hover:bg-emerald-500/20 transition-colors"
          >
            Create your first app
          </Link>
        </div>
      ) : (
        <ul className="divide-y divide-zinc-800/60">
          {apps.map((app) => (
            <li key={app.id} className="flex items-center gap-4 px-5 py-3.5 hover:bg-white/[0.03] transition-colors group">
              <Link
                href={`/apps/${app.id}`}
                className="flex min-w-0 flex-1 items-center gap-4"
              >
                <div
                  className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-linear-to-br from-emerald-500/20 to-teal-500/20 text-sm font-bold text-emerald-400"
                  aria-hidden="true"
                >
                  {app.name[0]?.toUpperCase()}
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-sm font-medium text-zinc-200 group-hover:text-emerald-400 transition-colors truncate">
                      {app.name}
                    </span>
                    <AppStatusBadge status={app.status} />
                  </div>
                  <AppListSecondaryLine app={app} />
                </div>
              </Link>
              <div className="hidden sm:flex items-center gap-3 shrink-0 text-xs font-medium">
                {app.clientId && (
                  <Link
                    href={`/apps/${app.id}/usage`}
                    className="text-zinc-500 hover:text-emerald-400 transition-colors"
                  >
                    Usage
                  </Link>
                )}
                <Link
                  href={`/apps/${app.id}`}
                  className="text-zinc-600 hover:text-zinc-300 transition-colors"
                >
                  Settings →
                </Link>
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
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
