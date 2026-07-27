"use client";

import Link from "next/link";
import MyAppsShortcutTiles from "@/components/apps/MyAppsShortcutTiles";

/**
 * My Apps home for explorers who have not created a provider app yet.
 */
export default function ExplorerHome() {
  return (
    <div className="space-y-6">
      <div className="mb-2">
        <h1 className="text-2xl font-bold text-zinc-100">My Apps</h1>
        <p className="mt-1 text-sm text-zinc-500">
          Call the Livepeer network yourself — or create an app when you&apos;re
          ready to ship.
        </p>
      </div>

      <MyAppsShortcutTiles />

      <div className="rounded-xl border border-dashed border-zinc-700 bg-zinc-900/20 p-6">
        <p className="text-sm font-medium text-zinc-200">Ready to ship a product?</p>
        <p className="mt-1 text-sm text-zinc-500">
          Upgrade to Builder — create your own app with plans, users, and the
          Builder API.
        </p>
        <Link
          href="/onboarding?resume=builder"
          className="mt-4 inline-flex rounded-lg bg-emerald-600 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-500"
        >
          Create your own app
        </Link>
      </div>
    </div>
  );
}
