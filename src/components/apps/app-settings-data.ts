import type { AppFormData, AppState } from "@/components/apps/AppWizard";
import { DEFAULT_PUBLIC_GRANT_TYPES } from "@/lib/oidc/grants";
import { DEFAULT_OIDC_SCOPES, ensureOpenIdScope } from "@/lib/oidc/scopes";

export type LoadedApp = {
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
};

export type AppSettingsApiPayload = {
  id?: string;
  name?: string;
  description?: string;
  developerName?: string;
  websiteUrl?: string;
  status?: string;
  ownerId?: string;
  canEdit?: boolean;
  canDeleteApp?: boolean;
  canManageBilling?: boolean;
  oidcClient?: {
    clientId?: string;
    allowedScopes?: string;
    grantTypes?: string;
    tokenEndpointAuthMethod?: AppFormData["tokenEndpointAuthMethod"];
    hasSecret?: boolean;
    postLogoutRedirectUris?: string[];
    initiateLoginUri?: string | null;
    deviceThirdPartyInitiateLogin?: boolean;
  } | null;
  m2mOidcClient?: { clientId: string; hasSecret: boolean } | null;
  webOidcClient?: {
    clientId: string;
    hasSecret: boolean;
    redirectUris?: string[];
    postLogoutRedirectUris?: string[];
  } | null;
  domains?: { id: string; domain: string }[];
};

const loadedAppCache = new Map<string, LoadedApp>();

export function peekLoadedApp(appId: string): LoadedApp | null {
  return loadedAppCache.get(appId) ?? null;
}

export function cacheLoadedApp(appId: string, data: LoadedApp): void {
  loadedAppCache.set(appId, data);
}

export function loadedAppFromApiPayload(data: AppSettingsApiPayload): LoadedApp {
  return {
    formData: {
      name: data.name || "",
      description: data.description || "",
      developerName: data.developerName || "",
      websiteUrl: data.websiteUrl || "",
      redirectUris: [],
      allowedScopes: ensureOpenIdScope(
        data.oidcClient?.allowedScopes || DEFAULT_OIDC_SCOPES,
      ),
      grantTypes:
        data.oidcClient?.grantTypes?.split(",").filter(Boolean) ??
        [...DEFAULT_PUBLIC_GRANT_TYPES],
      tokenEndpointAuthMethod:
        data.oidcClient?.tokenEndpointAuthMethod || "none",
      backendDeviceHelper: Boolean(data.m2mOidcClient),
      confidentialWebHelper: Boolean(data.webOidcClient),
      confidentialWebRedirectUris: data.webOidcClient?.redirectUris || [],
    },
    state: {
      id: data.id ?? null,
      clientId: data.oidcClient?.clientId || null,
      status: data.status ?? "",
      hasSecret: data.oidcClient?.hasSecret || false,
      backendHelper: data.m2mOidcClient ?? null,
      webHelper: data.webOidcClient
        ? {
            clientId: data.webOidcClient.clientId,
            hasSecret: data.webOidcClient.hasSecret,
            redirectUris: data.webOidcClient.redirectUris ?? [],
          }
        : null,
    },
    domains: (data.domains || []).map((d) => ({
      id: d.id,
      domain: d.domain,
    })),
    postLogoutRedirectUris:
      data.webOidcClient?.postLogoutRedirectUris ||
      data.oidcClient?.postLogoutRedirectUris ||
      [],
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
  };
}
