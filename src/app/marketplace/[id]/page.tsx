"use client";

import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import { useInsideDashboard } from "@/context/MarketplaceLayoutContext";
import { sanitizeUrl } from "@braintree/sanitize-url";

interface AppDetail {
  id: string;
  name: string;
  subtitle: string | null;
  description: string | null;
  category: string | null;
  logoLightUrl: string | null;
  logoDarkUrl: string | null;
  developerName: string | null;
  websiteUrl: string | null;
  supportUrl: string | null;
  privacyPolicyUrl: string | null;
  tosUrl: string | null;
  clientId: string | null;
  grantTypes: string | null;
  createdAt: string;
}

export default function MarketplaceAppDetailPage() {
  const { id } = useParams<{ id: string }>();
  const [app, setApp] = useState<AppDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);
  const [copied, setCopied] = useState<string | null>(null);

  useEffect(() => {
    fetch(`/api/v1/marketplace/${id}`)
      .then((r) => {
        if (!r.ok) {
          setNotFound(true);
          return null;
        }
        return r.json();
      })
      .then((data) => {
        if (data) setApp(data);
      })
      .finally(() => setLoading(false));
  }, [id]);

  const copyToClipboard = (text: string, label: string) => {
    navigator.clipboard.writeText(text);
    setCopied(label);
    setTimeout(() => setCopied(null), 2000);
  };

  if (loading) {
    return (
      <PageShell>
        <div className="text-zinc-500 text-center py-16 animate-pulse">
          Loading app...
        </div>
      </PageShell>
    );
  }

  if (notFound || !app) {
    return (
      <PageShell>
        <div className="text-center py-16">
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
                d="M9.172 16.172a4 4 0 015.656 0M9 10h.01M15 10h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"
              />
            </svg>
          </div>
          <h2 className="text-lg font-medium text-zinc-300 mb-2">
            App not found
          </h2>
          <p className="text-sm text-zinc-500 mb-6">
            This app may not exist or is not yet approved.
          </p>
          <Link
            href="/marketplace"
            className="inline-flex px-4 py-2 bg-emerald-600 text-white rounded-lg text-sm font-medium hover:bg-emerald-500 transition-colors"
          >
            Back to Marketplace
          </Link>
        </div>
      </PageShell>
    );
  }

  const grants = app.grantTypes?.split(",").filter(Boolean) || [];
  const safeWebsiteUrl = toSafeHref(app.websiteUrl);
  const safeSupportUrl = toSafeHref(app.supportUrl);
  const safePrivacyPolicyUrl = toSafeHref(app.privacyPolicyUrl);
  const safeTosUrl = toSafeHref(app.tosUrl);

  return (
    <PageShell>
      {/* Breadcrumb */}
      <div className="mb-6">
        <Link
          href="/marketplace"
          className="text-sm text-zinc-500 hover:text-zinc-300 transition-colors inline-flex items-center gap-1"
        >
          <svg
            className="w-4 h-4"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M15 19l-7-7 7-7"
            />
          </svg>
          Marketplace
        </Link>
      </div>

      {/* App header */}
      <div className="flex items-start gap-5 mb-8">
        <div className="w-16 h-16 bg-gradient-to-br from-emerald-500/20 to-teal-500/20 rounded-2xl flex items-center justify-center text-emerald-400 text-2xl font-bold shrink-0">
          {app.name[0]?.toUpperCase()}
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-3 flex-wrap">
            <h1 className="text-2xl font-bold text-zinc-100">{app.name}</h1>
            <span className="px-2.5 py-0.5 rounded-full text-xs font-medium bg-emerald-500/20 text-emerald-400">
              Approved
            </span>
          </div>
          {app.subtitle && (
            <p className="text-sm text-zinc-400 mt-1">{app.subtitle}</p>
          )}
          {app.developerName && (
            <p className="text-xs text-zinc-500 mt-1">
              by {app.developerName}
            </p>
          )}
        </div>
      </div>

      {/* Free usage banner */}
      <div className="mb-8 flex items-start gap-3 p-4 rounded-xl border border-teal-500/20 bg-teal-500/5">
        <svg
          className="w-5 h-5 text-teal-400 mt-0.5 shrink-0"
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={1.5}
            d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"
          />
        </svg>
        <div>
          <p className="text-sm font-medium text-teal-300">
            Free for a limited time
          </p>
          <p className="text-xs text-zinc-400 mt-0.5">
            This app is currently free to use. Usage is tracked and billing will
            be introduced in a future update.
          </p>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
        {/* Main content */}
        <div className="lg:col-span-2 space-y-6">
          {/* Description */}
          {app.description && (
            <div className="border border-zinc-800 rounded-xl p-6 bg-zinc-900/30">
              <h2 className="text-sm font-semibold text-zinc-300 uppercase tracking-wider mb-3">
                About
              </h2>
              <p className="text-sm text-zinc-400 leading-relaxed whitespace-pre-wrap">
                {app.description}
              </p>
            </div>
          )}

          {/* Integration details */}
          <div className="border border-zinc-800 rounded-xl p-6 bg-zinc-900/30">
            <h2 className="text-sm font-semibold text-zinc-300 uppercase tracking-wider mb-4">
              Integration
            </h2>
            <div className="space-y-4">
              {app.clientId && (
                <div>
                  <div className="block text-xs text-zinc-500 mb-1.5">
                    OIDC Client ID
                  </div>
                  <div className="flex items-center gap-2">
                    <code className="flex-1 px-3 py-2 bg-zinc-800/50 border border-zinc-700 rounded-lg text-sm text-zinc-300 font-mono">
                      {app.clientId}
                    </code>
                    <button
                      type="button"
                      onClick={() => copyToClipboard(app.clientId!, "clientId")}
                      className="px-3 py-2 text-xs text-zinc-400 hover:text-zinc-200 border border-zinc-700 rounded-lg hover:border-zinc-600 transition-colors shrink-0"
                    >
                      {copied === "clientId" ? "Copied!" : "Copy"}
                    </button>
                  </div>
                </div>
              )}

              {grants.length > 0 && (
                <div>
                  <div className="block text-xs text-zinc-500 mb-1.5">
                    Supported Grant Types
                  </div>
                  <div className="flex flex-wrap gap-2">
                    {grants.map((g) => (
                      <span
                        key={g}
                        className="px-2.5 py-1 bg-zinc-800/50 border border-zinc-700 rounded-lg text-xs text-zinc-400 font-mono"
                      >
                        {g.trim()}
                      </span>
                    ))}
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>

        {/* Sidebar */}
        <div className="space-y-6">
          {/* Category */}
          {app.category && (
            <div className="border border-zinc-800 rounded-xl p-5 bg-zinc-900/30">
              <h3 className="text-xs text-zinc-500 uppercase tracking-wider mb-2">
                Category
              </h3>
              <span className="text-sm text-zinc-300">{app.category}</span>
            </div>
          )}

          {/* Links */}
          {(safeWebsiteUrl || safeSupportUrl || safePrivacyPolicyUrl || safeTosUrl) && (
            <div className="border border-zinc-800 rounded-xl p-5 bg-zinc-900/30">
              <h3 className="text-xs text-zinc-500 uppercase tracking-wider mb-3">
                Links
              </h3>
              <div className="space-y-2">
                {safeWebsiteUrl && (
                  <ExternalLink href={safeWebsiteUrl} label="Website" />
                )}
                {safeSupportUrl && (
                  <ExternalLink href={safeSupportUrl} label="Support" />
                )}
                {safePrivacyPolicyUrl && (
                  <ExternalLink
                    href={safePrivacyPolicyUrl}
                    label="Privacy Policy"
                  />
                )}
                {safeTosUrl && (
                  <ExternalLink href={safeTosUrl} label="Terms of Service" />
                )}
              </div>
            </div>
          )}

          {/* Published date */}
          <div className="border border-zinc-800 rounded-xl p-5 bg-zinc-900/30">
            <h3 className="text-xs text-zinc-500 uppercase tracking-wider mb-2">
              Published
            </h3>
            <span className="text-sm text-zinc-300">
              {new Date(app.createdAt).toLocaleDateString(undefined, {
                year: "numeric",
                month: "long",
                day: "numeric",
              })}
            </span>
          </div>
        </div>
      </div>
    </PageShell>
  );
}

function PageShell({ children }: Readonly<{ children: React.ReactNode }>) {
  const insideDashboard = useInsideDashboard();

  if (insideDashboard) {
    return <>{children}</>;
  }

  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-100">
      <header className="border-b border-zinc-800 bg-zinc-900/50">
        <div className="max-w-6xl mx-auto px-6 py-6 flex items-center justify-between">
          <div>
            <Link href="/" className="text-xl font-bold tracking-tight">
              <span className="text-emerald-400">pymt</span>house
            </Link>
            <p className="text-xs text-zinc-500 mt-0.5">App Marketplace</p>
          </div>
          <Link
            href="/login"
            className="px-4 py-2 text-sm text-zinc-400 hover:text-zinc-200 border border-zinc-700 rounded-lg hover:border-zinc-600 transition-colors"
          >
            Sign In
          </Link>
        </div>
      </header>
      <div className="max-w-6xl mx-auto px-6 py-10">{children}</div>
    </div>
  );
}

function ExternalLink({ href, label }: Readonly<{ href: string; label: string }>) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="flex items-center gap-2 text-sm text-zinc-400 hover:text-emerald-400 transition-colors"
    >
      <svg
        className="w-4 h-4 shrink-0"
        fill="none"
        stroke="currentColor"
        viewBox="0 0 24 24"
      >
        <path
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth={1.5}
          d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14"
        />
      </svg>
      {label}
    </a>
  );
}

/** Returns a sanitized http/https URL, or null for anything unsafe. */
function toSafeHref(href: string | null | undefined): string | null {
  if (!href) return null;
  const trimmed = href.trim();
  if (!trimmed) return null;
  // Reject protocol-relative URLs (//evil.com) — sanitizeUrl does not block these.
  if (trimmed.startsWith("//")) return null;
  const safe = sanitizeUrl(trimmed);
  return safe === "about:blank" ? null : safe;
}
