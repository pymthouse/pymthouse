import {
  getHostedOpenMeterUrl,
  isKonnectMeteringUrl,
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

/**
 * Resolve a Konnect API path against a configured base URL.
 * Rejects scheme/host injection so path segments cannot redirect the request
 * off the configured OpenMeter / Konnect origin (tssecurity:S8476).
 * @internal Exported for unit tests.
 */
export function toKonnectApiUrl(baseUrl: string, path: string): string {
  const trimmedPath = path.trim();
  if (
    !trimmedPath.startsWith("/") ||
    trimmedPath.startsWith("//") ||
    trimmedPath.includes("://") ||
    trimmedPath.includes("\\") ||
    trimmedPath.includes("..")
  ) {
    throw new Error("Invalid Konnect API path");
  }

  let base: URL;
  try {
    // Trailing slash so a leading-/ path is joined under the base pathname
    // (`…/v3/openmeter` + `/customers` → `…/v3/openmeter/customers`), not
    // replaced at the origin root.
    base = new URL(baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`);
  } catch {
    throw new Error("Invalid Konnect API base URL");
  }

  const url = new URL(trimmedPath.slice(1), base);
  if (url.origin !== base.origin) {
    throw new Error("Konnect API origin mismatch");
  }

  const basePathPrefix = base.pathname.replace(/\/$/, "") || "";
  if (basePathPrefix && !url.pathname.startsWith(`${basePathPrefix}/`) && url.pathname !== basePathPrefix) {
    throw new Error("Konnect API path escaped configured base path");
  }

  // Pin to Kong Konnect (or local OpenMeter in tests/dev). Env-configured
  // OPENMETER_URL must already be a Konnect metering URL in production; this
  // is a second belt so a mis-set env cannot send the Bearer token elsewhere.
  const host = url.hostname.toLowerCase();
  const isLocal =
    host === "127.0.0.1" || host === "localhost" || host === "host.docker.internal";
  if (!isLocal && !isKonnectMeteringUrl(url.origin)) {
    throw new Error("Konnect API host is not allowlisted");
  }

  return url.href;
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
  const url = toKonnectApiUrl(baseUrl, path);
  return konnectFetchJson<T>(url, path, init, label);
}

export async function konnectMeteringV1Fetch<T>(
  path: string,
  init?: RequestInit,
  label = "metering-v1",
): Promise<T> {
  const baseUrl = konnectMeteringV1BaseUrl();
  const url = toKonnectApiUrl(baseUrl, path);
  return konnectFetchJson<T>(url, path, init, label);
}
