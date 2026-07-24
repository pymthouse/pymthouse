"use client";

import Link from "next/link";
import { getDocsBaseUrl } from "@/lib/docs-base-url";

/**
 * Documentation + Usage shortcuts shown above the apps list on My Apps.
 */
export default function MyAppsShortcutTiles() {
  return (
    <div className="mb-6 grid grid-cols-1 gap-4 sm:grid-cols-2">
      <div className="rounded-xl border border-white/[0.06] bg-white/[0.02] p-5 flex flex-col justify-between gap-3">
        <div>
          <h3 className="font-semibold text-zinc-100">Documentation</h3>
          <p className="text-xs text-zinc-500 mt-1">
            Builder API, OIDC, device flow, and integration guides.
          </p>
        </div>
        <a
          href={getDocsBaseUrl()}
          target="_blank"
          rel="noopener noreferrer"
          className="text-sm font-medium text-emerald-400 hover:text-emerald-300 transition-colors self-start"
        >
          Open Docs →
        </a>
      </div>
      <div className="rounded-xl border border-white/[0.06] bg-white/[0.02] p-5 flex flex-col justify-between gap-3">
        <div>
          <h3 className="font-semibold text-zinc-100">Usage</h3>
          <p className="text-xs text-zinc-500 mt-1">
            Request charts and signed-ticket history are on the Usage page.
          </p>
        </div>
        <Link
          href="/usage"
          className="text-sm font-medium text-emerald-400 hover:text-emerald-300 transition-colors self-start"
        >
          Open Usage →
        </Link>
      </div>
    </div>
  );
}
