/**
 * Discovery-service URL configuration for the hosted MCP.
 *
 * `DISCOVERY_SERVICE_URL` / `DISCOVERY_URL` hold the FULL raw endpoint
 * (`https://host/v1/discovery/raw`) — the ecosystem convention shared with the
 * Livepeer dashboard (`dashboard/lib/discovery/config.ts`). Two accessors split
 * the two meanings:
 *   - `readDiscoveryRawUrl()`     → the configured endpoint, embedded as-is in
 *                                   livepeer-python-gateway `--token` payloads.
 *   - `readDiscoveryServiceUrl()` → its ORIGIN, used to build sibling
 *                                   `/v1/discovery/*` API routes.
 *
 * Unset config falls back to the hosted default (the MCP metadata endpoint is
 * public and must not 500). A malformed value throws — silently substituting a
 * different production host on a typo would be worse than a loud failure.
 */

const DISCOVERY_ENV_KEYS = [
  "DISCOVERY_SERVICE_URL",
  "DISCOVERY_URL",
  "LIVEPEER_DISCOVERY_SERVICE_URL",
] as const;

const DEFAULT_DISCOVERY_RAW_PATH = "/v1/discovery/raw";

/** Hosted default: full raw endpoint, same host the dashboard ships with. */
export const DEFAULT_DISCOVERY_RAW_URL = `https://discovery-service-production-8955.up.railway.app${DEFAULT_DISCOVERY_RAW_PATH}`;

function readConfiguredDiscoveryUrl(): string | undefined {
  for (const key of DISCOVERY_ENV_KEYS) {
    const value = process.env[key]?.trim();
    if (value) return value;
  }
  return undefined;
}

function parseDiscoveryUrl(): URL {
  const configured = readConfiguredDiscoveryUrl() ?? DEFAULT_DISCOVERY_RAW_URL;
  let parsed: URL;
  try {
    parsed = new URL(configured);
  } catch {
    throw new Error(
      `Invalid discovery service URL "${configured}": set DISCOVERY_SERVICE_URL ` +
        `to the full raw endpoint, e.g. ${DEFAULT_DISCOVERY_RAW_URL}`,
    );
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(
      `Discovery service URL must be an http(s) URL: "${configured}"`,
    );
  }
  return parsed;
}

/**
 * Origin of the configured discovery service, for sibling API routes
 * (`/v1/discovery/query`, `/v1/discovery/freshness`). Path, query and fragment
 * of the configured raw endpoint are dropped.
 */
export function readDiscoveryServiceUrl(): string {
  return parseDiscoveryUrl().origin;
}

/**
 * Full raw discovery endpoint, as configured (path and query preserved).
 * Consumed by livepeer-python-gateway `--token` payloads.
 *
 * A configured value with no path (i.e. an origin) is backfilled with the
 * default raw path so origin-style deployments keep working.
 */
export function readDiscoveryRawUrl(): string {
  const parsed = parseDiscoveryUrl();
  while (parsed.pathname.length > 1 && parsed.pathname.endsWith("/")) {
    parsed.pathname = parsed.pathname.slice(0, -1);
  }
  if (parsed.pathname === "/" || parsed.pathname === "") {
    parsed.pathname = DEFAULT_DISCOVERY_RAW_PATH;
  }
  return parsed.toString();
}

/** Absolute URL for a discovery-service API path, joined against the origin. */
export function buildDiscoveryApiUrl(path: string): string {
  return new URL(path, readDiscoveryServiceUrl()).toString();
}

/**
 * Raw discovery endpoint scoped to live-runner, for SDK `--token` payloads.
 * `searchParams.set` replaces an existing `serviceType` and preserves any other
 * query params already present on the configured value.
 */
export function readLiveRunnerDiscoveryUrl(): string {
  const url = new URL(readDiscoveryRawUrl());
  url.searchParams.set("serviceType", "live-runner");
  return url.toString();
}

export function extractBearerToken(authorization: string | null): string {
  if (!authorization?.trim()) {
    throw new Error("Authorization Bearer token is required");
  }
  const value = authorization.trim();
  if (value.toLowerCase().startsWith("bearer ")) {
    return value.slice(7).trim();
  }
  return value;
}
