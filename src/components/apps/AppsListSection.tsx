"use client";

import { useState } from "react";
import Link from "next/link";
import AppStatusBadge from "@/components/apps/AppStatusBadge";
import OwnerApiKeyMintDialog from "@/components/apps/OwnerApiKeyMintDialog";
import { useOwnerApiKeyMint } from "@/components/apps/use-owner-api-key-mint";
import type { UserAppSummary } from "@/lib/user-apps";

type AppListSecondaryLineProps = Readonly<{ app: UserAppSummary; showOwner: boolean }>;

function AppListSecondaryLine({ app, showOwner }: AppListSecondaryLineProps) {
  if (showOwner) {
    const owner = app.ownerName || app.ownerEmail;
    return (
      <p className="text-xs text-zinc-500 mt-0.5 truncate">
        {owner ? `Owner: ${owner}` : "Owner: unknown"}
        {app.isOwner ? " (you)" : ""}
      </p>
    );
  }
  if (app.subtitle) {
    return <p className="text-xs text-zinc-500 mt-0.5 truncate">{app.subtitle}</p>;
  }
  return null;
}

const iconBtnClass =
  "inline-flex h-8 w-8 items-center justify-center rounded-lg border border-zinc-700/80 text-zinc-400 transition-colors hover:border-zinc-600 hover:bg-white/[0.04] hover:text-zinc-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500/40";

function UsageIcon(props: Readonly<{ className?: string }>) {
  return (
    <svg className={props.className ?? "h-3.5 w-3.5"} fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden>
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={1.75}
        d="M3 13h2l2-5 3 10 3-7 2 2h6"
      />
    </svg>
  );
}

function SettingsIcon(props: Readonly<{ className?: string }>) {
  return (
    <svg className={props.className ?? "h-3.5 w-3.5"} fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden>
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={1.75}
        d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z"
      />
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.75} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
    </svg>
  );
}

export type AppsListSectionProps = Readonly<{
  apps: UserAppSummary[];
  title?: string;
  summaryText: string;
  emptyStateTitle?: string;
  emptyStateBody?: string;
  headerRight?: React.ReactNode;
  showOwner?: boolean;
  loading?: boolean;
  /** Number of apps shown per page (default 5); apps are pre-sorted by the caller. */
  pageSize?: number;
  /** Currently selected app id for usage filtering (optional). */
  selectedAppId?: string | null;
  /** When set, clicking a row selects/deselects that app for usage filtering. */
  onSelectApp?: (app: UserAppSummary | null) => void;
}>;

function PageNavButton({
  direction,
  disabled,
  onClick,
}: Readonly<{ direction: "prev" | "next"; disabled: boolean; onClick: () => void }>) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={direction === "prev" ? "Previous page" : "Next page"}
      className="inline-flex h-7 w-7 items-center justify-center rounded-md border border-zinc-700 text-zinc-400 transition-colors hover:border-zinc-600 hover:text-zinc-100 disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:border-zinc-700 disabled:hover:text-zinc-400"
    >
      <svg className="h-3.5 w-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden>
        <path
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth={2}
          d={direction === "prev" ? "M15 19l-7-7 7-7" : "M9 5l7 7-7 7"}
        />
      </svg>
    </button>
  );
}

export default function AppsListSection({
  apps,
  title = "My Apps",
  summaryText,
  emptyStateTitle = "No apps yet.",
  emptyStateBody,
  headerRight,
  showOwner = false,
  loading = false,
  pageSize = 5,
  selectedAppId = null,
  onSelectApp,
}: AppsListSectionProps) {
  const { mintState, handleGetApiKey, closeMintDialog } =
    useOwnerApiKeyMint<UserAppSummary>();
  const [page, setPage] = useState(0);

  const totalPages = Math.max(1, Math.ceil(apps.length / pageSize));
  const currentPage = Math.min(page, totalPages - 1);
  const pageStart = currentPage * pageSize;
  const pageApps = apps.slice(pageStart, pageStart + pageSize);
  const showPagination = !loading && apps.length > pageSize;
  const selectable = typeof onSelectApp === "function";

  return (
    <>
      <section className="rounded-xl border border-emerald-500/15 bg-white/[0.02] backdrop-blur-sm shadow-[inset_0_1px_0_rgba(52,211,153,0.06)]">
        <div className="flex flex-col gap-3 border-b border-white/[0.06] px-5 py-4 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h3 className="font-semibold text-zinc-100">{title}</h3>
            <p className="text-sm text-zinc-500 mt-0.5">{summaryText}</p>
          </div>
          <div className="flex flex-wrap items-center gap-3 shrink-0">
            {headerRight}
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

        {loading ? (
          <div className="divide-y divide-zinc-800/60 animate-pulse">
            {["a", "b", "c"].map((key) => (
              <div key={key} className="flex items-center gap-4 px-5 py-3.5">
                <div className="h-9 w-9 shrink-0 rounded-lg bg-zinc-800" />
                <div className="flex-1 space-y-2">
                  <div className="h-3 w-32 rounded bg-zinc-800" />
                  <div className="h-2.5 w-48 rounded bg-zinc-800/70" />
                </div>
              </div>
            ))}
          </div>
        ) : apps.length === 0 ? (
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
            <p className="text-sm text-zinc-400 mb-4">{emptyStateTitle}</p>
            {emptyStateBody ? (
              <p className="text-xs text-zinc-500 mb-4 max-w-sm mx-auto">{emptyStateBody}</p>
            ) : null}
            <Link
              href="/apps/new"
              className="inline-flex px-4 py-2 bg-emerald-500/10 text-emerald-400 border border-emerald-500/25 rounded-lg text-sm font-medium hover:bg-emerald-500/20 transition-colors"
            >
              Create your first app
            </Link>
          </div>
        ) : (
          <ul className="divide-y divide-zinc-800/60">
            {pageApps.map((app) => {
              const selected = selectedAppId === app.id;
              return (
                <li
                  key={app.id}
                  className={`flex items-center gap-3 px-5 py-3.5 transition-colors group ${
                    selected
                      ? "bg-emerald-500/[0.07] ring-1 ring-inset ring-emerald-500/25"
                      : "hover:bg-white/[0.03]"
                  }`}
                >
                  {selectable ? (
                    <button
                      type="button"
                      onClick={() => onSelectApp(selected ? null : app)}
                      aria-pressed={selected}
                      aria-label={
                        selected
                          ? `Clear usage filter for ${app.name}`
                          : `Filter usage to ${app.name}`
                      }
                      className="flex min-w-0 flex-1 items-center gap-4 text-left rounded-lg focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500/40"
                    >
                      <div
                        className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-linear-to-br from-emerald-500/20 to-teal-500/20 text-sm font-bold text-emerald-400"
                        aria-hidden="true"
                      >
                        {app.name[0]?.toUpperCase()}
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-2">
                          <span
                            className={`text-sm font-medium truncate transition-colors ${
                              selected
                                ? "text-emerald-300"
                                : "text-zinc-200 group-hover:text-emerald-400"
                            }`}
                          >
                            {app.name}
                          </span>
                          <AppStatusBadge status={app.status} />
                        </div>
                        <AppListSecondaryLine app={app} showOwner={showOwner} />
                      </div>
                    </button>
                  ) : (
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
                        <AppListSecondaryLine app={app} showOwner={showOwner} />
                      </div>
                    </Link>
                  )}
                  <div className="flex items-center gap-1.5 shrink-0">
                    {app.clientId && (
                      <Link
                        href={`/apps/${app.id}/usage`}
                        className={iconBtnClass}
                        title="Usage"
                        aria-label={`Open usage for ${app.name}`}
                      >
                        <UsageIcon />
                      </Link>
                    )}
                    <Link
                      href={`/apps/${app.id}`}
                      className={iconBtnClass}
                      title="Settings"
                      aria-label={`Open settings for ${app.name}`}
                    >
                      <SettingsIcon />
                    </Link>
                    {app.isOwner && app.ownerExternalUserId && app.clientId ? (
                      <button
                        type="button"
                        onClick={() => handleGetApiKey(app)}
                        disabled={mintState?.phase === "minting" && mintState.appId === app.id}
                        title="Get API Key"
                        aria-label={`Get API key for ${app.name}`}
                        className={`${iconBtnClass} border-emerald-600/40 text-emerald-400 hover:border-emerald-500 hover:bg-emerald-500/10 hover:text-emerald-300 disabled:cursor-not-allowed disabled:opacity-60`}
                      >
                        {mintState?.phase === "minting" && mintState.appId === app.id ? (
                          <span
                            className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-emerald-600/40 border-t-emerald-400"
                            aria-hidden
                          />
                        ) : (
                          <svg className="h-3.5 w-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden>
                            <path
                              strokeLinecap="round"
                              strokeLinejoin="round"
                              strokeWidth={1.75}
                              d="M15 7a2 2 0 012 2m4 0a6 6 0 01-7.743 5.743L11 17H9v2H7v2H4a1 1 0 01-1-1v-2.586a1 1 0 01.293-.707l5.964-5.964A6 6 0 1121 9z"
                            />
                          </svg>
                        )}
                      </button>
                    ) : null}
                  </div>
                </li>
              );
            })}
          </ul>
        )}

        {showPagination && (
          <div className="flex items-center justify-between gap-3 border-t border-white/[0.06] px-5 py-3">
            <p className="text-xs text-zinc-500">
              Showing {pageStart + 1}–{Math.min(pageStart + pageSize, apps.length)} of{" "}
              {apps.length}
            </p>
            <div className="flex items-center gap-2">
              <PageNavButton
                direction="prev"
                disabled={currentPage === 0}
                onClick={() => setPage((p) => Math.max(0, p - 1))}
              />
              <span className="text-xs font-medium text-zinc-500 tabular-nums">
                {currentPage + 1} / {totalPages}
              </span>
              <PageNavButton
                direction="next"
                disabled={currentPage >= totalPages - 1}
                onClick={() => setPage((p) => Math.min(totalPages - 1, p + 1))}
              />
            </div>
          </div>
        )}
      </section>

      <OwnerApiKeyMintDialog
        mintState={mintState?.phase === "minting" ? null : mintState}
        onClose={closeMintDialog}
        onRetry={handleGetApiKey}
      />
    </>
  );
}
