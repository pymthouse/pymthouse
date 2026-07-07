"use client";

import Link from "next/link";
import AppStatusBadge from "@/components/apps/AppStatusBadge";
import OwnerApiKeyMintDialog from "@/components/apps/OwnerApiKeyMintDialog";
import { useOwnerApiKeyMint } from "@/components/apps/use-owner-api-key-mint";
import type { UserAppSummary } from "@/lib/user-apps";

function myAppsSummaryText(count: number): string {
  if (count === 0) return "No apps yet — create one to get started.";
  if (count === 1) return "1 app — open settings or usage from here.";
  return `${count} apps — open settings or usage from here.`;
}

type AppListSecondaryLineProps = Readonly<{ app: UserAppSummary }>;

function AppListSecondaryLine({ app }: AppListSecondaryLineProps) {
  if (app.clientId) {
    return (
      <p className="text-xs text-zinc-500 font-mono mt-0.5 truncate">
        {app.clientId}
      </p>
    );
  }
  if (app.subtitle) {
    return (
      <p className="text-xs text-zinc-500 mt-0.5 truncate">{app.subtitle}</p>
    );
  }
  return null;
}

export default function MyAppsSection({ apps }: Readonly<{ apps: UserAppSummary[] }>) {
  const { mintState, handleGetApiKey, closeMintDialog } =
    useOwnerApiKeyMint<UserAppSummary>();

  return (
    <>
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
                  {app.isOwner && app.ownerExternalUserId && app.clientId ? (
                    <button
                      type="button"
                      onClick={() => handleGetApiKey(app)}
                      disabled={mintState?.phase === "minting" && mintState.appId === app.id}
                      className="inline-flex items-center gap-1 rounded-md border border-emerald-600/50 px-2 py-0.5 text-xs font-medium text-emerald-400 transition-colors hover:border-emerald-500 hover:bg-emerald-500/10 hover:text-emerald-300 disabled:cursor-not-allowed disabled:opacity-60"
                    >
                      {mintState?.phase === "minting" && mintState.appId === app.id ? (
                        <span
                          className="h-3 w-3 animate-spin rounded-full border-2 border-emerald-600/40 border-t-emerald-400"
                          aria-hidden
                        />
                      ) : (
                        <svg className="h-3 w-3" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden>
                          <path
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            strokeWidth={1.75}
                            d="M15 7a2 2 0 012 2m4 0a6 6 0 01-7.743 5.743L11 17H9v2H7v2H4a1 1 0 01-1-1v-2.586a1 1 0 01.293-.707l5.964-5.964A6 6 0 1121 9z"
                          />
                        </svg>
                      )}
                      {mintState?.phase === "minting" && mintState.appId === app.id ? "Getting…" : "Get API Key"}
                    </button>
                  ) : null}
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      <OwnerApiKeyMintDialog
        mintState={
          mintState?.phase === "minting" ? null : mintState
        }
        onClose={closeMintDialog}
        onRetry={handleGetApiKey}
      />
    </>
  );
}
