"use client";

import { useState } from "react";
import AdminAppsSection from "@/components/apps/AdminAppsSection";
import MyAppsShortcutTiles from "@/components/apps/MyAppsShortcutTiles";
import type { UserAppSummary } from "@/lib/user-apps";

/**
 * Admin My Apps body: docs + usage shortcuts and full apps list (own / all toggle).
 * Usage analytics live on /usage.
 */
export default function AdminAppsHome({
  myApps,
}: Readonly<{
  myApps: UserAppSummary[];
}>) {
  const [showAllApps, setShowAllApps] = useState(false);

  return (
    <>
      <MyAppsShortcutTiles />

      <AdminAppsSection
        initialApps={myApps}
        showAll={showAllApps}
        onToggleShowAll={setShowAllApps}
      />
    </>
  );
}
