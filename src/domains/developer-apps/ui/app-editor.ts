"use client";

import { DEFAULT_OIDC_SCOPES } from "@/platform/oidc/scopes";

const DEVICE_CODE_GRANT = "urn:ietf:params:oauth:grant-type:device_code";

const DEFAULT_GRANT_TYPES_WITH_DEVICE = [
  "authorization_code",
  "refresh_token",
  DEVICE_CODE_GRANT,
] as const;

export interface AppFormData {
  name: string;
  description: string;
  developerName: string;
  websiteUrl: string;
  tokenEndpointAuthMethod: "none" | "client_secret_post" | "client_secret_basic";
  redirectUris: string[];
  allowedScopes: string;
  grantTypes: string[];
  backendDeviceHelper: boolean;
  initiateLoginUri: string;
  deviceThirdPartyInitiateLogin: boolean;
}

export interface AppState {
  id: string | null;
  clientId: string | null;
  status: string;
  hasSecret: boolean;
  backendHelper: { clientId: string; hasSecret: boolean } | null;
  pendingRevisionSubmittedAt?: string | null;
}

export interface AppDomain {
  id: string;
  domain: string;
}

export interface AppEditorModel {
  formData: Partial<AppFormData>;
  state: AppState;
  domains: AppDomain[];
  postLogoutRedirectUris: string[];
  initiateLoginUri: string | null;
  deviceThirdPartyInitiateLogin: boolean;
  canEdit: boolean;
  canSubmitForReview: boolean;
}

type AppDetailResponse = {
  id: string;
  name?: string | null;
  description?: string | null;
  developerName?: string | null;
  websiteUrl?: string | null;
  status: string;
  canEdit?: boolean;
  canSubmitForReview?: boolean;
  domains?: AppDomain[];
  m2mOidcClient?: { clientId: string; hasSecret: boolean } | null;
  oidcClient?: {
    clientId?: string | null;
    redirectUris?: string[];
    allowedScopes?: string | null;
    grantTypes?: string | null;
    tokenEndpointAuthMethod?: "none" | "client_secret_post" | "client_secret_basic";
    hasSecret?: boolean;
    postLogoutRedirectUris?: string[];
    initiateLoginUri?: string | null;
    deviceThirdPartyInitiateLogin?: boolean;
  } | null;
};

export const defaultAppFormData: AppFormData = {
  name: "",
  description: "",
  developerName: "",
  websiteUrl: "",
  tokenEndpointAuthMethod: "none",
  redirectUris: [],
  allowedScopes: `${DEFAULT_OIDC_SCOPES} users:token`.trim(),
  grantTypes: [...DEFAULT_GRANT_TYPES_WITH_DEVICE],
  backendDeviceHelper: true,
  initiateLoginUri: "",
  deviceThirdPartyInitiateLogin: false,
};

export const APP_STATUS_LABELS: Record<string, { label: string; color: string }> = {
  draft: { label: "Draft", color: "bg-zinc-700 text-zinc-300" },
  submitted: { label: "Submitted", color: "bg-blue-500/20 text-blue-400" },
  in_review: { label: "In Review", color: "bg-amber-500/20 text-amber-400" },
  approved: { label: "Approved", color: "bg-emerald-500/20 text-emerald-400" },
  rejected: { label: "Rejected", color: "bg-red-500/20 text-red-400" },
};

export function createWizardFormData(initialData?: Partial<AppFormData>): AppFormData {
  return {
    ...defaultAppFormData,
    ...initialData,
    grantTypes:
      initialData?.grantTypes !== undefined
        ? [...initialData.grantTypes]
        : [...defaultAppFormData.grantTypes],
    redirectUris:
      initialData?.redirectUris !== undefined
        ? [...initialData.redirectUris]
        : [...defaultAppFormData.redirectUris],
  };
}

export function createSettingsFormData(
  initial: Partial<AppFormData>,
  initialInitiateLoginUri: string | null,
  initialDeviceThirdPartyInitiateLogin: boolean,
): AppFormData {
  return {
    ...defaultAppFormData,
    ...initial,
    redirectUris: initial.redirectUris ?? [...defaultAppFormData.redirectUris],
    grantTypes:
      initial.grantTypes !== undefined
        ? [...initial.grantTypes]
        : [...defaultAppFormData.grantTypes],
    allowedScopes: initial.allowedScopes ?? defaultAppFormData.allowedScopes,
    backendDeviceHelper: initial.backendDeviceHelper ?? false,
    initiateLoginUri: initial.initiateLoginUri ?? initialInitiateLoginUri ?? "",
    deviceThirdPartyInitiateLogin:
      initial.deviceThirdPartyInitiateLogin ?? initialDeviceThirdPartyInitiateLogin,
  };
}

export function mapAppDetailToEditorModel(data: AppDetailResponse): AppEditorModel {
  return {
    formData: {
      name: data.name || "",
      description: data.description || "",
      developerName: data.developerName || "",
      websiteUrl: data.websiteUrl || "",
      redirectUris: data.oidcClient?.redirectUris || [],
      allowedScopes: data.oidcClient?.allowedScopes || DEFAULT_OIDC_SCOPES,
      grantTypes: data.oidcClient?.grantTypes?.split(",").filter(Boolean) || [
        "authorization_code",
        "refresh_token",
      ],
      tokenEndpointAuthMethod: data.oidcClient?.tokenEndpointAuthMethod || "none",
      backendDeviceHelper: Boolean(data.m2mOidcClient),
    },
    state: {
      id: data.id,
      clientId: data.oidcClient?.clientId || null,
      status: data.status,
      hasSecret: data.oidcClient?.hasSecret || false,
      backendHelper: data.m2mOidcClient ?? null,
    },
    domains: (data.domains || []).map((domain) => ({
      id: domain.id,
      domain: domain.domain,
    })),
    postLogoutRedirectUris: data.oidcClient?.postLogoutRedirectUris || [],
    initiateLoginUri: data.oidcClient?.initiateLoginUri ?? null,
    deviceThirdPartyInitiateLogin: data.oidcClient?.deviceThirdPartyInitiateLogin === true,
    canEdit: data.canEdit === true,
    canSubmitForReview: data.canSubmitForReview === true,
  };
}

export function getAppStatusInfo(status: string) {
  return APP_STATUS_LABELS[status] || APP_STATUS_LABELS.draft;
}
