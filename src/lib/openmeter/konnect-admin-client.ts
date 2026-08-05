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

/**
 * Cloud UI / portal subscription lifecycle API
 * (`https://{region}.api.konghq.com/metering/v1`).
 * Exposes restore + scheduled DELETE that `/v3/openmeter` does not route.
 */
export function konnectMeteringV1BaseUrl(): string {
  const openmeterBase = normalizeKonnectMeteringUrl(getHostedOpenMeterUrl());
  return `${new URL(openmeterBase).origin}/metering/v1`;
}

async function konnectFetchJson<T>(
  url: string,
  pathForError: string,
  init: RequestInit | undefined,
  label: string,
): Promise<T> {
  const { apiKey } = konnectAdminConfig();
  const response = await fetch(url, {
    ...init,
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
      ...init?.headers,
    },
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(
      `Konnect ${label} API ${init?.method ?? "GET"} ${pathForError} failed (${response.status}): ${body}`,
    );
  }

  if (response.status === 204) {
    return undefined as T;
  }

  return (await response.json()) as T;
}

export async function konnectAdminFetch<T>(
  path: string,
  init?: RequestInit,
  label = "admin",
): Promise<T> {
  const { baseUrl } = konnectAdminConfig();
  return konnectFetchJson<T>(`${baseUrl}${path}`, path, init, label);
}

export async function konnectMeteringV1Fetch<T>(
  path: string,
  init?: RequestInit,
  label = "metering-v1",
): Promise<T> {
  const baseUrl = konnectMeteringV1BaseUrl();
  return konnectFetchJson<T>(`${baseUrl}${path}`, path, init, label);
}
