"use client";

import AppsListSection from "@/components/apps/AppsListSection";
import type { UserAppSummary } from "@/lib/user-apps";

function myAppsSummaryText(count: number): string {
  if (count === 0) return "No apps yet — create one to get started.";
  if (count === 1) return "1 app — open settings or usage from here.";
  return `${count} apps — open settings or usage from here.`;
}

export default function MyAppsSection({ apps }: Readonly<{ apps: UserAppSummary[] }>) {
  return (
    <AppsListSection
      apps={apps}
      summaryText={myAppsSummaryText(apps.length)}
      emptyStateTitle="No apps yet."
    />
  );
}
