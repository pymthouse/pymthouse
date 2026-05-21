"use client";

import { useCallback, useMemo, useState } from "react";
import { createDeveloperApp } from "./app-editor-api";
import { createWizardFormData, type AppFormData } from "./app-editor";
import {
  buildAppAuthModeModel,
  getToggleDeviceCodeUpdates,
  getToggleHelperUpdates,
} from "./app-auth-mode";

export interface AppWizardState {
  formData: AppFormData;
  callbackUrl: string;
  saving: boolean;
  error: string | null;
  showAdvanced: boolean;
  hasDeviceCode: boolean;
  hasIssueUserTokens: boolean;
  canSubmit: boolean;
  setField: <K extends keyof AppFormData>(key: K, value: AppFormData[K]) => void;
  setCallbackUrl: (value: string) => void;
  toggleAdvanced: () => void;
  toggleConfidential: (checked: boolean) => void;
  toggleDeviceCode: () => void;
  toggleIssueUserTokens: () => void;
  submit: () => Promise<string>;
}

export function useAppWizardState(initialData?: Partial<AppFormData>): AppWizardState {
  const [formData, setFormData] = useState<AppFormData>(() => createWizardFormData(initialData));
  const [callbackUrl, setCallbackUrl] = useState(initialData?.redirectUris?.[0] ?? "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showAdvanced, setShowAdvanced] = useState(false);

  const authModeModel = useMemo(() => buildAppAuthModeModel(formData), [formData]);

  const setField = useCallback(<K extends keyof AppFormData>(key: K, value: AppFormData[K]) => {
    setFormData((prev) => ({ ...prev, [key]: value }));
  }, []);

  const toggleAdvanced = useCallback(() => {
    setShowAdvanced((value) => !value);
  }, []);

  const toggleConfidential = useCallback((checked: boolean) => {
    const updates = getToggleHelperUpdates(formData, checked, false);
    if (!updates) return;
    setFormData((prev) => ({ ...prev, ...updates }));
  }, [formData]);

  const toggleDeviceCode = useCallback(() => {
    const updates = getToggleDeviceCodeUpdates(formData, false);
    if (!updates) return;
    setFormData((prev) => ({ ...prev, ...updates }));
  }, [formData]);

  const toggleIssueUserTokens = useCallback(() => {
    if (!formData.backendDeviceHelper) return;
    const nextScopes = authModeModel.hasIssueUserTokens
      ? authModeModel.scopes.filter((scope) => scope !== "users:token")
      : [...authModeModel.scopes, "users:token"];
    setField("allowedScopes", nextScopes.join(" "));
  }, [authModeModel.hasIssueUserTokens, authModeModel.scopes, formData.backendDeviceHelper, setField]);

  const submit = useCallback(async () => {
    setSaving(true);
    setError(null);
    try {
      const payload: AppFormData = {
        ...formData,
        redirectUris: callbackUrl.trim() ? [callbackUrl.trim()] : [],
      };
      return await createDeveloperApp(payload);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown error";
      setError(message);
      throw err;
    } finally {
      setSaving(false);
    }
  }, [callbackUrl, formData]);

  return {
    formData,
    callbackUrl,
    saving,
    error,
    showAdvanced,
    hasDeviceCode: authModeModel.hasDeviceCode,
    hasIssueUserTokens: authModeModel.hasIssueUserTokens,
    canSubmit: !saving && formData.name.trim().length > 0,
    setField,
    setCallbackUrl,
    toggleAdvanced,
    toggleConfidential,
    toggleDeviceCode,
    toggleIssueUserTokens,
    submit,
  };
}
