"use client";

import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import AppSettingsScreen from "@/components/apps/AppSettingsScreen";
import AppStatusBadge from "@/components/apps/AppStatusBadge";
import {
  cacheLoadedApp,
  loadedAppFromApiPayload,
  peekLoadedApp,
  type LoadedApp,
} from "@/components/apps/app-settings-data";
import type { AppSettingsTab } from "@/lib/apps/settings-paths";

/** Shared app settings shell. Tab comes from the path (`/apps/{id}/payments`). */
export default function AppSettingsPageClient({
  tab,
}: Readonly<{ tab: AppSettingsTab }>) {
  const { id } = useParams<{ id: string }>();
  const cached = peekLoadedApp(id);

  const [loading, setLoading] = useState(!cached);
  const [appData, setAppData] = useState<LoadedApp | null>(cached);

  useEffect(() => {
    let cancelled = false;
    const existing = peekLoadedApp(id);
    if (existing) {
      setAppData(existing);
      setLoading(false);
    } else {
      setLoading(true);
    }

    fetch(`/api/v1/apps/${id}`)
      .then((r) => {
        if (!r.ok) return null;
        return r.json();
      })
      .then((data) => {
        if (cancelled) return;
        if (!data) {
          if (!peekLoadedApp(id)) setAppData(null);
          return;
        }
        const loaded = loadedAppFromApiPayload(data);
        cacheLoadedApp(id, loaded);
        setAppData(loaded);
      })
      .catch(() => {
        if (!cancelled) setAppData(peekLoadedApp(id));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [id]);

  if (loading && !appData) {
    return (
      <div className="text-zinc-500 text-center py-12 animate-pulse">
        Loading app…
      </div>
    );
  }

  if (!appData) {
    return (
      <div className="text-center py-12">
        <h2 className="text-lg font-medium text-zinc-300">App not found</h2>
      </div>
    );
  }

  return (
    <>
      <div className="mb-8">
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="text-2xl font-bold text-zinc-100">
            {appData.formData.name || "App"}
          </h1>
          <AppStatusBadge status={appData.state.status} />
        </div>
      </div>

      <AppSettingsScreen
        key={id}
        appId={id}
        initialData={appData.formData}
        initialState={appData.state}
        initialDomains={appData.domains}
        initialPostLogoutRedirectUris={appData.postLogoutRedirectUris}
        initialInitiateLoginUri={appData.initiateLoginUri}
        initialDeviceThirdPartyInitiateLogin={
          appData.deviceThirdPartyInitiateLogin
        }
        canEdit={appData.canEdit}
        canDeleteApp={appData.canDeleteApp}
        canManageBilling={appData.canManageBilling}
        ownerExternalUserId={appData.ownerExternalUserId}
        initialTab={tab}
      />
    </>
  );
}
