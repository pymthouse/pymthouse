"use client";

import Link from "next/link";

export default function CompleteSetupBanner() {
  return (
    <div className="mb-6 rounded-xl border border-amber-500/30 bg-amber-500/10 px-4 py-3 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
      <p className="text-sm text-amber-100/90">
        Finish setup to create an app and get signing keys.
      </p>
      <Link
        href="/onboarding?resume=builder"
        className="inline-flex shrink-0 rounded-lg bg-amber-600/90 px-3 py-1.5 text-xs font-medium text-white hover:bg-amber-500"
      >
        Complete setup
      </Link>
    </div>
  );
}
