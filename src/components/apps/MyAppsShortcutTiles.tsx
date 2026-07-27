"use client";

import Link from "next/link";
import { getDocsBaseUrl } from "@/lib/docs-base-url";

/**
 * API Keys + Usage + Documentation shortcuts on My Apps.
 */
export default function MyAppsShortcutTiles() {
  return (
    <div className="mb-6 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
      <div className="flex flex-col justify-between gap-3 rounded-xl border border-white/[0.06] bg-white/[0.02] p-5">
        <div>
          <h3 className="font-semibold text-zinc-100">API Keys</h3>
          <p className="mt-1 text-xs text-zinc-500">
            Create and revoke tokens for personal network access and your apps.
          </p>
        </div>
        <Link
          href="/keys"
          className="self-start text-sm font-medium text-emerald-400 transition-colors hover:text-emerald-300"
        >
          Manage keys →
        </Link>
      </div>
      <div className="flex flex-col justify-between gap-3 rounded-xl border border-white/[0.06] bg-white/[0.02] p-5">
        <div>
          <h3 className="font-semibold text-zinc-100">Usage</h3>
          <p className="mt-1 text-xs text-zinc-500">
            Request charts and signed-ticket history are on the Usage page.
          </p>
        </div>
        <Link
          href="/usage"
          className="self-start text-sm font-medium text-emerald-400 transition-colors hover:text-emerald-300"
        >
          Open Usage →
        </Link>
      </div>
      <div className="flex flex-col justify-between gap-3 rounded-xl border border-white/[0.06] bg-white/[0.02] p-5">
        <div>
          <h3 className="font-semibold text-zinc-100">Documentation</h3>
          <p className="mt-1 text-xs text-zinc-500">
            Builder API, OIDC, device flow, and integration guides.
          </p>
        </div>
        <a
          href={getDocsBaseUrl()}
          target="_blank"
          rel="noopener noreferrer"
          className="self-start text-sm font-medium text-emerald-400 transition-colors hover:text-emerald-300"
        >
          Open Docs →
        </a>
      </div>
    </div>
  );
}
