import {
  getHostedOpenMeterUrl,
  normalizeKonnectMeteringUrl,
} from "./constants";

export function konnectAdminConfig(): { baseUrl: string; apiKey: string } {
  const apiKey = process.env.OPENMETER_API_KEY?.trim();
  if (!apiKey) {
    throw new Error("OPENMETER_API_KEY is required for Konnect admin API access");
  }
  return {
    baseUrl: normalizeKonnectMeteringUrl(getHostedOpenMeterUrl()),
    apiKey,
  };
}

export async function konnectAdminFetch<T>(
  path: string,
  init?: RequestInit,
  label = "admin",
): Promise<T> {
  const { baseUrl, apiKey } = konnectAdminConfig();
  const response = await fetch(`${baseUrl}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
      ...init?.headers,
    },
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(
      `Konnect ${label} API ${init?.method ?? "GET"} ${path} failed (${response.status}): ${body}`,
    );
  }

  if (response.status === 204) {
    return undefined as T;
  }

  return (await response.json()) as T;
}
