"use client";

import type { AppFormData } from "./app-editor";
import { OIDC_SCOPES, type ScopeDefinition } from "@/platform/oidc/scopes";
import { validateInitiateLoginUri } from "@/platform/oidc/third-party-initiate-login";

export const DEVICE_CODE_GRANT = "urn:ietf:params:oauth:grant-type:device_code";

export interface AppAuthModeModel {
  scopes: string[];
  hasDeviceCode: boolean;
  hasAuthCodeFlow: boolean;
  requiresIssueUserTokens: boolean;
  hasIssueUserTokens: boolean;
  baseScopes: ScopeDefinition[];
  helperScopes: ScopeDefinition[];
}

export function isValidInitiateLoginUri(uri: string): boolean {
  const trimmed = uri.trim();
  if (!trimmed.length) return false;
  try {
    validateInitiateLoginUri(trimmed);
    return true;
  } catch {
    return false;
  }
}

export function buildAppAuthModeModel(data: AppFormData): AppAuthModeModel {
  const scopes = data.allowedScopes.split(/\s+/).filter(Boolean);
  const hasDeviceCode = data.grantTypes.includes(DEVICE_CODE_GRANT);
  const hasAuthCodeFlow = data.grantTypes.includes("authorization_code");
  const requiresIssueUserTokens =
    hasDeviceCode &&
    data.deviceThirdPartyInitiateLogin &&
    isValidInitiateLoginUri(data.initiateLoginUri);
  const hasIssueUserTokens = scopes.includes("users:token");

  return {
    scopes,
    hasDeviceCode,
    hasAuthCodeFlow,
    requiresIssueUserTokens,
    hasIssueUserTokens,
    baseScopes: OIDC_SCOPES.filter((scope) =>
      ["openid", "sign:job"].includes(scope.value),
    ),
    helperScopes: OIDC_SCOPES.filter((scope) => scope.value === "users:token"),
  };
}

export function ensureRequiredUserTokenScope(data: AppFormData): Partial<AppFormData> | null {
  const model = buildAppAuthModeModel(data);
  if (!model.requiresIssueUserTokens || model.hasIssueUserTokens) return null;
  return { allowedScopes: [...model.scopes, "users:token"].join(" ") };
}

export function getToggledScopeUpdates(
  data: AppFormData,
  scope: string,
  readOnly: boolean,
): Partial<AppFormData> | null {
  const model = buildAppAuthModeModel(data);
  if (readOnly || scope === "openid") return null;
  if (scope === "users:token" && model.requiresIssueUserTokens) return null;
  const nextScopes = model.scopes.includes(scope)
    ? model.scopes.filter((value) => value !== scope)
    : [...model.scopes, scope];
  return { allowedScopes: nextScopes.join(" ") };
}

export function getToggleRefreshTokenUpdates(
  data: AppFormData,
  readOnly: boolean,
): Partial<AppFormData> | null {
  if (readOnly) return null;
  const hasRefreshToken = data.grantTypes.includes("refresh_token");
  return {
    grantTypes: hasRefreshToken
      ? data.grantTypes.filter((value) => value !== "refresh_token")
      : [...data.grantTypes, "refresh_token"],
  };
}

export function getToggleDeviceCodeUpdates(
  data: AppFormData,
  readOnly: boolean,
): Partial<AppFormData> | null {
  if (readOnly || !data.backendDeviceHelper) return null;
  const hasDeviceCode = data.grantTypes.includes(DEVICE_CODE_GRANT);
  if (hasDeviceCode) {
    return {
      grantTypes: data.grantTypes.filter((value) => value !== DEVICE_CODE_GRANT),
      initiateLoginUri: "",
      deviceThirdPartyInitiateLogin: false,
    };
  }
  return { grantTypes: [...data.grantTypes, DEVICE_CODE_GRANT] };
}

export function getToggleHelperUpdates(
  data: AppFormData,
  checked: boolean,
  readOnly: boolean,
): Partial<AppFormData> | null {
  if (readOnly) return null;
  const model = buildAppAuthModeModel(data);
  if (checked) {
    const nextScopes = model.scopes.includes("users:token")
      ? model.scopes
      : [...model.scopes, "users:token"];
    return { backendDeviceHelper: true, allowedScopes: nextScopes.join(" ") };
  }
  return {
    backendDeviceHelper: false,
    grantTypes: data.grantTypes.filter((value) => value !== DEVICE_CODE_GRANT),
    initiateLoginUri: "",
    deviceThirdPartyInitiateLogin: false,
    allowedScopes: model.scopes.filter((scope) => scope !== "users:token").join(" "),
  };
}

export function getInitiateLoginUpdates(value: string): Partial<AppFormData> {
  return {
    initiateLoginUri: value,
    deviceThirdPartyInitiateLogin: isValidInitiateLoginUri(value),
  };
}
