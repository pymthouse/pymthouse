"use client";

import { usePathname } from "next/navigation";
import type { ReactNode } from "react";
import AppSettingsPageClient from "@/components/apps/AppSettingsPageClient";
import { appSettingsTabFromPathname } from "@/lib/apps/settings-paths";

/**
 * Keeps the settings client mounted across `/apps/{id}/{tab}` navigations
 * so the navbar (from the parent layout) does not wait on a remounted fetch.
 */
export default function AppSettingsRouteShell({
  children,
}: Readonly<{ children: ReactNode }>) {
  const pathname = usePathname();
  const tab = appSettingsTabFromPathname(pathname);

  if (!tab) {
    return children;
  }

  return <AppSettingsPageClient tab={tab} />;
}
