"use client";

import { useEffect, useState } from "react";
import DashboardLayout from "@/components/DashboardLayout";
import AppsListSection from "@/components/apps/AppsListSection";
import type { UserAppSummary } from "@/lib/user-apps";

function myAppsSummaryText(count: number, loading: boolean): string {
  if (loading) return "Loading your apps…";
  if (count === 0) return "No apps yet — create one to get started.";
  if (count === 1) return "1 app — open settings or usage from the icons.";
  return `${count} apps — open settings or usage from the icons.`;
}

export default function AppsPage() {
  const [apps, setApps] = useState<UserAppSummary[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch("/api/v1/apps")
      .then((r) => r.json())
      .then((data: { apps?: UserAppSummary[] }) => setApps(data.apps || []))
      .finally(() => setLoading(false));
  }, []);

  return (
    <DashboardLayout>
      <div className="mb-8">
        <h1 className="text-2xl font-bold text-zinc-100">My Apps</h1>
        <p className="mt-1 text-sm text-zinc-500">Manage your provider applications</p>
      </div>

      <AppsListSection
        apps={apps}
        loading={loading}
        title=""
        summaryText={myAppsSummaryText(apps.length, loading)}
        emptyStateTitle="No apps yet."
        emptyStateBody="Create your first provider app to configure identity, plans, user management, and signer access."
      />
    </DashboardLayout>
  );
}
