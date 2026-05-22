"use client";

import {
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import Link from "next/link";
import DashboardLayout from "@/components/DashboardLayout";

interface AppSummary {
  id: string;
  name: string;
  subtitle: string | null;
  category: string | null;
  status: string;
  logoLightUrl: string | null;
  clientId: string | null;
  createdAt: string;
}

const STATUS_REVIEW = new Set(["submitted", "in_review"]);

function appStatusAriaLabel(status: string): string {
  switch (status) {
    case "approved":
      return "Live — approved";
    case "draft":
      return "Draft";
    case "submitted":
      return "Submitted — awaiting review";
    case "in_review":
      return "In review";
    case "rejected":
      return "Rejected";
    default:
      return status.replaceAll("_", " ");
  }
}

function AppStatusIndicator({
  status,
  suppressAccessibleLabel,
}: {
  status: string;
  /** When wrapped by a parent that provides tooltip / name (e.g. a Link with `title`). */
  suppressAccessibleLabel?: boolean;
}) {
  const label = appStatusAriaLabel(status);
  const common = suppressAccessibleLabel
    ? { "aria-hidden": true as const }
    : {
        title: label,
        "aria-label": label,
        role: "img" as const,
      };

  if (status === "approved") {
    return (
      <span className="inline-flex shrink-0 items-center justify-center p-1" {...common}>
        <span className="h-2 w-2 rounded-full bg-emerald-500 ring-2 ring-emerald-500/35" />
      </span>
    );
  }

  if (status === "draft") {
    return (
      <span
        className="inline-flex shrink-0 items-center justify-center p-1 text-zinc-500"
        {...common}
      >
        <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden>
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={1.75}
            d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z"
          />
        </svg>
      </span>
    );
  }

  if (STATUS_REVIEW.has(status)) {
    return (
      <span
        className="inline-flex shrink-0 items-center justify-center p-1 text-amber-400/95"
        {...common}
      >
        <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden>
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={1.75}
            d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"
          />
        </svg>
      </span>
    );
  }

  if (status === "rejected") {
    return (
      <span
        className="inline-flex shrink-0 items-center justify-center p-1 text-red-400/90"
        {...common}
      >
        <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden>
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={1.75}
            d="M18.364 18.364A9 9 0 005.636 5.636m12.728 12.728A9 9 0 015.636 5.636m12.728 12.728L5.636 5.636"
          />
        </svg>
      </span>
    );
  }

  return (
    <span className="inline-flex shrink-0 items-center justify-center p-1 text-zinc-500" {...common}>
      <span className="h-2 w-2 rounded-full bg-zinc-500" />
    </span>
  );
}

function CopyPublicAppIdButton({
  clientId,
  className,
}: {
  clientId: string;
  /** Merged onto the button (e.g. for stacking above a card hit-area link). */
  className?: string;
}) {
  const [copied, setCopied] = useState(false);
  const [copyFailed, setCopyFailed] = useState(false);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (timeoutRef.current !== null) {
        clearTimeout(timeoutRef.current);
      }
    };
  }, []);

  const copy = useCallback(() => {
    if (typeof navigator === "undefined" || !navigator.clipboard) {
      setCopied(false);
      setCopyFailed(true);
      if (timeoutRef.current !== null) {
        clearTimeout(timeoutRef.current);
      }
      timeoutRef.current = setTimeout(() => {
        timeoutRef.current = null;
        setCopyFailed(false);
      }, 2000);
      return;
    }

    void navigator.clipboard.writeText(clientId).then(
      () => {
        setCopyFailed(false);
        setCopied(true);
        if (timeoutRef.current !== null) {
          clearTimeout(timeoutRef.current);
        }
        timeoutRef.current = setTimeout(() => {
          timeoutRef.current = null;
          setCopied(false);
        }, 2000);
      },
      () => {
        setCopied(false);
        setCopyFailed(true);
        if (timeoutRef.current !== null) {
          clearTimeout(timeoutRef.current);
        }
        timeoutRef.current = setTimeout(() => {
          timeoutRef.current = null;
          setCopyFailed(false);
        }, 2000);
      },
    );
  }, [clientId]);

  return (
    <button
      type="button"
      onClick={copy}
      className={`pointer-events-auto relative z-10 shrink-0 rounded-md border border-zinc-700 bg-zinc-800 p-1.5 text-zinc-300 hover:bg-zinc-700 hover:text-zinc-100 transition-colors ${className ?? ""}`}
      aria-label={
        copied ? "Copied" : copyFailed ? "Copy failed" : "Copy public app id"
      }
    >
      {copied ? (
        <svg
          className="h-4 w-4 text-emerald-400"
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
          aria-hidden
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={2}
            d="M5 13l4 4L19 7"
          />
        </svg>
      ) : (
        <svg
          className="h-4 w-4"
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
          aria-hidden
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={1.5}
            d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z"
          />
        </svg>
      )}
    </button>
  );
}

export default function AppsPage() {
  const [apps, setApps] = useState<AppSummary[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch("/api/v1/apps")
      .then((r) => r.json())
      .then((data) => setApps(data.apps || []))
      .finally(() => setLoading(false));
  }, []);

  return (
    <DashboardLayout>
      <div className="flex items-center justify-between mb-8">
        <div>
          <h1 className="text-2xl font-bold text-zinc-100">My Apps</h1>
          <p className="text-sm text-zinc-500 mt-1">
            Manage your provider applications
          </p>
        </div>
        <Link
          href="/apps/new"
          className="px-4 py-2 bg-emerald-600 text-white rounded-lg text-sm font-medium hover:bg-emerald-500 transition-colors"
        >
          Create New App
        </Link>
      </div>

      {loading ? (
        <div className="text-zinc-500 text-center py-12 animate-pulse">
          Loading apps...
        </div>
      ) : apps.length === 0 ? (
        <div className="text-center py-16 border border-zinc-800 rounded-xl bg-zinc-900/20">
          <div className="w-16 h-16 bg-zinc-800 rounded-xl flex items-center justify-center mx-auto mb-4">
            <svg
              className="w-8 h-8 text-zinc-600"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={1.5}
                d="M20 7l-8-4-8 4m16 0l-8 4m8-4v10l-8 4m0-10L4 7m8 4v10M4 7v10l8 4"
              />
            </svg>
          </div>
          <h2 className="text-lg font-medium text-zinc-300 mb-2">
            No apps yet
          </h2>
          <p className="text-sm text-zinc-500 mb-6 max-w-sm mx-auto">
            Create your first provider app to configure identity, plans, user
            management, and signer access.
          </p>
          <Link
            href="/apps/new"
            className="inline-flex px-5 py-2.5 bg-emerald-600 text-white rounded-lg text-sm font-medium hover:bg-emerald-500 transition-colors"
          >
            Create Your First App
          </Link>
        </div>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {apps.map((app) => (
            <div
              key={app.id}
              className="relative flex h-full min-h-0 flex-col rounded-xl border border-zinc-800 bg-zinc-900/30 transition-colors group hover:border-zinc-700 hover:bg-zinc-900/60"
            >
              <Link
                href={`/apps/${app.id}`}
                className="absolute inset-0 z-0 cursor-pointer rounded-xl outline-offset-2 focus-visible:outline focus-visible:outline-2 focus-visible:outline-emerald-500/60"
                aria-label={`${app.name} — open app settings`}
              />
              <div className="relative z-10 flex h-full min-h-0 flex-col gap-3 p-5 pointer-events-none">
                <div className="flex items-start justify-between gap-2">
                  <div className="flex min-w-0 flex-1 items-start gap-3">
                    <div
                      className="flex h-10 w-10 shrink-0 bg-linear-to-br from-emerald-500/20 to-teal-500/20 rounded-lg items-center justify-center text-emerald-400 text-sm font-bold"
                      aria-hidden
                    >
                      {app.name[0]?.toUpperCase()}
                    </div>
                    <div className="min-w-0 flex-1 text-left">
                      <div className="block min-w-0">
                        <h3 className="text-sm font-semibold text-zinc-200 group-hover:text-emerald-400 transition-colors leading-tight break-words">
                          {app.name}
                        </h3>
                      </div>
                      {app.clientId ? (
                        <div className="mt-2 space-y-1">
                          <div className="text-[10px] font-medium uppercase tracking-wide text-zinc-500">
                            Public app id
                          </div>
                          <div className="grid min-w-0 grid-cols-[1fr_auto] items-start gap-x-1.5 gap-y-0">
                            <code className="min-w-0 col-start-1 text-left text-xs font-mono leading-snug text-zinc-400 break-all">
                              {app.clientId}
                            </code>
                            <CopyPublicAppIdButton
                              clientId={app.clientId}
                              className="col-start-2 self-start -translate-y-0.5"
                            />
                          </div>
                        </div>
                      ) : null}
                    </div>
                  </div>
                  <Link
                    href={`/apps/${app.id}`}
                    className="pointer-events-auto relative z-10 inline-flex shrink-0 rounded outline-offset-2 focus-visible:outline focus-visible:outline-2 focus-visible:outline-emerald-500/60"
                    title={appStatusAriaLabel(app.status)}
                    aria-label={`App status: ${appStatusAriaLabel(app.status)}`}
                  >
                    <AppStatusIndicator status={app.status} suppressAccessibleLabel />
                  </Link>
                </div>

                {app.subtitle ? (
                  <p className="text-xs text-zinc-500 leading-snug">{app.subtitle}</p>
                ) : null}

                {app.category ? (
                  <Link
                    href={`/apps/${app.id}`}
                    className="pointer-events-auto relative z-10 w-fit text-xs text-zinc-500 hover:text-zinc-400 transition-colors"
                  >
                    {app.category}
                  </Link>
                ) : null}

                {app.clientId ? (
                  <nav
                    className="pointer-events-auto relative z-10 mt-auto flex flex-wrap justify-end gap-x-3 gap-y-1 border-t border-zinc-800/80 pt-3 text-sm font-medium"
                    aria-label={`Shortcuts for ${app.name}`}
                  >
                    <Link
                      href={`/apps/${app.id}/usage`}
                      className="shrink-0 text-zinc-400 underline decoration-zinc-600/45 decoration-1 underline-offset-[3px] hover:text-emerald-400 hover:decoration-emerald-500/35"
                    >
                      Usage
                    </Link>
                    <Link
                      href={`/apps/${app.id}`}
                      className="shrink-0 text-zinc-400 underline decoration-zinc-600/45 decoration-1 underline-offset-[3px] hover:text-emerald-400 hover:decoration-emerald-500/35"
                    >
                      Settings
                    </Link>
                  </nav>
                ) : null}
              </div>
            </div>
          ))}
        </div>
      )}
    </DashboardLayout>
  );
}
