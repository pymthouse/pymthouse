"use client";

import { useCallback, useState } from "react";
import AppsListSection from "@/components/apps/AppsListSection";
import type { UserAppSummary } from "@/lib/user-apps";

function summaryText(count: number, showingAll: boolean): string {
  if (count === 0) {
    return showingAll ? "No apps exist on the platform yet." : "You don't own any apps yet.";
  }
  const noun = count === 1 ? "app" : "apps";
  return showingAll
    ? `${count} ${noun} across the platform.`
    : `${count} ${noun} you own or administer.`;
}

export default function AdminAppsSection({
  initialApps,
  showAll,
  onToggleShowAll,
}: Readonly<{
  initialApps: UserAppSummary[];
  showAll: boolean;
  onToggleShowAll: (next: boolean) => void;
}>) {
  const [allApps, setAllApps] = useState<UserAppSummary[] | null>(null);
  const [loadingAll, setLoadingAll] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadAllApps = useCallback(() => {
    if (allApps !== null || loadingAll) return;
    setLoadingAll(true);
    setError(null);
    fetch("/api/v1/apps?scope=all")
      .then((r) => {
        if (!r.ok) throw new Error("Failed to load all apps");
        return r.json();
      })
      .then((data) => setAllApps(data.apps || []))
      .catch(() => setError("Failed to load all apps."))
      .finally(() => setLoadingAll(false));
  }, [allApps, loadingAll]);

  const handleToggle = () => {
    const next = !showAll;
    onToggleShowAll(next);
    if (next) loadAllApps();
  };

  const apps = showAll ? allApps ?? [] : initialApps;
  const loading = showAll && allApps === null && loadingAll;

  return (
    <div className="space-y-2">
      <AppsListSection
        key={showAll ? "all" : "own"}
        apps={apps}
        title={showAll ? "All Apps" : "My Apps"}
        summaryText={summaryText(apps.length, showAll)}
        emptyStateTitle={showAll ? "No apps yet." : "You don't own any apps yet."}
        showOwner={showAll}
        loading={loading}
        headerRight={
          <div className="flex items-center gap-2.5 select-none">
            <span className="text-sm font-medium text-zinc-400">All apps</span>
            <button
              type="button"
              role="switch"
              aria-checked={showAll}
              aria-label="Toggle between my apps and all apps"
              onClick={handleToggle}
              className={`relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors duration-150 focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500/50 ${
                showAll ? "bg-emerald-600" : "bg-zinc-700"
              }`}
            >
              <span
                className={`inline-block h-3.5 w-3.5 transform rounded-full bg-white shadow transition-transform duration-150 ${
                  showAll ? "translate-x-[19px]" : "translate-x-[3px]"
                }`}
              />
            </button>
          </div>
        }
      />
      {error && <p className="text-xs text-red-400">{error}</p>}
    </div>
  );
}
