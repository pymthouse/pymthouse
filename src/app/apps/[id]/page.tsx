"use client";

import { useEffect, useState } from "react";
import { useParams, useSearchParams } from "next/navigation";
import DashboardLayout from "@/components/DashboardLayout";
import AppSettingsScreen from "@/components/apps/AppSettingsScreen";
import AppStatusBadge from "@/components/apps/AppStatusBadge";
import type { AppFormData, AppState } from "@/components/apps/AppWizard";
import { DEFAULT_PUBLIC_GRANT_TYPES } from "@/lib/oidc/grants";
import { DEFAULT_OIDC_SCOPES, ensureOpenIdScope } from "@/lib/oidc/scopes";

export default function AppDetailPage() {
  const { id } = useParams<{ id: string }>();
  const searchParams = useSearchParams();
  const initialTab = searchParams.get("tab") ?? undefined;

  const [loading, setLoading] = useState(true);
  const [appData, setAppData] = useState<{
    formData: Partial<AppFormData>;
    state: AppState;
    domains: { id: string; domain: string }[];
    postLogoutRedirectUris: string[];
    initiateLoginUri: string | null;
    deviceThirdPartyInitiateLogin: boolean;
    canEdit: boolean;
    canDeleteApp: boolean;
    canManageBilling: boolean;
    ownerExternalUserId: string | null;
  } | null>(null);

  useEffect(() => {
    fetch(`/api/v1/apps/${id}`)
      .then((r) => {
        if (!r.ok) return null;
        return r.json();
      })
      .then((data) => {
        if (!data) {
          setAppData(null);
          return;
        }
        setAppData({
          formData: {
            name: data.name || "",
            description: data.description || "",
            developerName: data.developerName || "",
            websiteUrl: data.websiteUrl || "",
            redirectUris: data.oidcClient?.redirectUris || [],
            allowedScopes: ensureOpenIdScope(
              data.oidcClient?.allowedScopes || DEFAULT_OIDC_SCOPES,
            ),
            grantTypes:
              data.oidcClient?.grantTypes?.split(",").filter(Boolean) ??
              [...DEFAULT_PUBLIC_GRANT_TYPES],
            tokenEndpointAuthMethod:
              data.oidcClient?.tokenEndpointAuthMethod || "none",
            backendDeviceHelper: Boolean(data.m2mOidcClient),
            x402Enabled: data.x402Enabled === 1 || data.x402Enabled === true,
            onrampEnabled:
              data.onrampEnabled === undefined
                ? true
                : data.onrampEnabled === 1 || data.onrampEnabled === true,
            x402PayToAddress: data.x402PayToAddress || "",
          },
          state: {
            id: data.id,
            clientId: data.oidcClient?.clientId || null,
            status: data.status,
            hasSecret: data.oidcClient?.hasSecret || false,
            backendHelper: data.m2mOidcClient ?? null,
          },
          domains: (data.domains || []).map(
            (d: { id: string; domain: string }) => ({
              id: d.id,
              domain: d.domain,
            }),
          ),
          postLogoutRedirectUris: data.oidcClient?.postLogoutRedirectUris || [],
          initiateLoginUri: data.oidcClient?.initiateLoginUri ?? null,
          deviceThirdPartyInitiateLogin:
            data.oidcClient?.deviceThirdPartyInitiateLogin === true,
          canEdit: data.canEdit === true,
          canDeleteApp: data.canDeleteApp === true,
          canManageBilling: data.canManageBilling === true,
          ownerExternalUserId:
            typeof data.ownerId === "string" && data.ownerId.trim()
              ? data.ownerId.trim()
              : null,
        });
      })
      .catch(() => setAppData(null))
      .finally(() => setLoading(false));
  }, [id]);

  if (loading) {
    return (
      <DashboardLayout>
        <div className="text-zinc-500 text-center py-12 animate-pulse">
          Loading app…
        </div>
      </DashboardLayout>
    );
  }

  if (!appData) {
    return (
      <DashboardLayout>
        <div className="text-center py-12">
          <h2 className="text-lg font-medium text-zinc-300">App not found</h2>
        </div>
      </DashboardLayout>
    );
  }

  return (
    <DashboardLayout>
      <div className="mb-8">
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="text-2xl font-bold text-zinc-100">
            {appData.formData.name || "App"}
          </h1>
          <AppStatusBadge status={appData.state.status} />
        </div>
        <p className="text-sm text-zinc-500 mt-1">
          Edit integration settings, credentials, network discovery, and pricing.
        </p>
      </div>

      <AppSettingsScreen
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
        initialTab={initialTab}
      />
    </DashboardLayout>
  );
}
