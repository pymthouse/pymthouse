"use client";

import type { AppEditorModel, AppFormData } from "./app-editor";
import { mapAppDetailToEditorModel } from "./app-editor";

async function parseError(res: Response, fallback: string): Promise<string> {
  const text = await res.text();
  try {
    const data = text ? JSON.parse(text) : {};
    if (typeof data.message === "string" && data.message) return data.message;
    if (typeof data.error === "string" && data.error) return data.error;
  } catch {
    if (text.trim()) return text.trim().slice(0, 500);
  }
  return fallback;
}

export async function fetchAppEditorModel(appId: string): Promise<AppEditorModel | null> {
  const res = await fetch(`/api/v1/apps/${appId}`);
  if (!res.ok) return null;
  const data = await res.json();
  return mapAppDetailToEditorModel(data);
}

export async function createDeveloperApp(formData: AppFormData): Promise<string> {
  const res = await fetch("/api/v1/apps", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(formData),
  });
  if (!res.ok) {
    throw new Error(await parseError(res, `Failed to create app (${res.status})`));
  }
  const data = (await res.json()) as { id: string };
  return data.id;
}

export async function saveDeveloperApp(appId: string, formData: AppFormData) {
  const res = await fetch(`/api/v1/apps/${appId}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...formData }),
  });
  if (!res.ok) {
    throw new Error(await parseError(res, `Failed to save (${res.status})`));
  }
  return (await res.json()) as {
    success?: boolean;
    m2mOidcClient?: { clientId: string; hasSecret: boolean } | null;
  };
}

export async function saveDeveloperAppSettings(
  appId: string,
  {
    postLogoutRedirectUris,
    initiateLoginUri,
    deviceThirdPartyInitiateLogin,
    tokenEndpointAuthMethod,
  }: {
    postLogoutRedirectUris: string[];
    initiateLoginUri: string | null;
    deviceThirdPartyInitiateLogin: boolean;
    tokenEndpointAuthMethod: AppFormData["tokenEndpointAuthMethod"];
  },
) {
  const res = await fetch(`/api/v1/apps/${appId}/settings`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      postLogoutRedirectUris,
      initiateLoginUri,
      deviceThirdPartyInitiateLogin,
      tokenEndpointAuthMethod,
    }),
  });
  if (!res.ok) {
    throw new Error(
      await parseError(res, "App metadata saved, but failed to save OIDC settings"),
    );
  }
}

export async function submitDeveloperAppForReview(appId: string) {
  const res = await fetch(`/api/v1/apps/${appId}/submit`, {
    method: "POST",
  });
  if (!res.ok) {
    throw new Error(await parseError(res, `Submit failed (${res.status})`));
  }
}

export async function revertDeveloperAppToDraft(appId: string) {
  const res = await fetch(`/api/v1/apps/${appId}/revert-draft`, {
    method: "POST",
  });
  if (!res.ok) {
    throw new Error(await parseError(res, `Revert failed (${res.status})`));
  }
}

export async function deleteDeveloperApp(appId: string) {
  const res = await fetch(`/api/v1/apps/${appId}`, { method: "DELETE" });
  if (!res.ok) {
    throw new Error(await parseError(res, `Delete failed (${res.status})`));
  }
}

export async function generateDeveloperAppSecret(appId: string): Promise<string | null> {
  const res = await fetch(`/api/v1/apps/${appId}/credentials`, {
    method: "POST",
  });
  if (!res.ok) {
    throw new Error(await parseError(res, `Failed to generate secret (${res.status})`));
  }
  const data = (await res.json()) as { clientSecret?: string };
  return data.clientSecret ?? null;
}
