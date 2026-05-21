"use client";

import type { AppDomain } from "./app-editor";

async function parseDomainError(res: Response): Promise<string> {
  const text = await res.text();
  try {
    const data = text ? JSON.parse(text) : {};
    if (typeof data.error === "string" && data.error.trim()) {
      return data.error.trim();
    }
  } catch {
    /* keep fallback */
  }
  return text.trim() || res.statusText || `Domain request failed (${res.status})`;
}

export async function saveDeveloperAppRedirectUris(
  appId: string,
  redirectUris: string[],
): Promise<void> {
  const res = await fetch(`/api/v1/apps/${appId}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ redirectUris }),
  });

  if (!res.ok) {
    const text = await res.text();
    let message = `Failed to save redirect URIs (${res.status})`;
    try {
      const data = text ? JSON.parse(text) : {};
      if (typeof data.error === "string" && data.error.trim()) {
        message = data.error.trim();
      }
    } catch {
      /* keep generic */
    }
    throw new Error(message);
  }
}

export function getRedirectUriOrigin(uri: string): string | null {
  try {
    const origin = new URL(uri).origin;
    return origin === "null" ? null : origin.toLowerCase();
  } catch {
    return null;
  }
}

export function getAutoWhitelistedDomain(
  redirectUri: string,
  domains: AppDomain[],
): string | null {
  const normalizedOrigin = getRedirectUriOrigin(redirectUri);
  if (!normalizedOrigin) return null;
  if (domains.some((domain) => domain.domain.toLowerCase() === normalizedOrigin)) {
    return null;
  }
  return normalizedOrigin;
}

export async function addDeveloperAppDomain(
  appId: string,
  domain: string,
): Promise<AppDomain> {
  const res = await fetch(`/api/v1/apps/${appId}/domains`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ domain }),
  });

  if (!res.ok) {
    throw new Error(await parseDomainError(res));
  }

  return (await res.json()) as AppDomain;
}

export async function removeDeveloperAppDomain(
  appId: string,
  domainId: string,
): Promise<void> {
  const res = await fetch(
    `/api/v1/apps/${appId}/domains?domainId=${encodeURIComponent(domainId)}`,
    {
      method: "DELETE",
    },
  );

  if (!res.ok) {
    throw new Error(await parseDomainError(res));
  }
}
