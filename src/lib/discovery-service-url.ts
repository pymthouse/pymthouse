/**
 * Canonical Livepeer discovery-service URL helpers.
 *
 * Accepts either env name and either URL shape:
 * - origin/base: `https://discovery-service…up.railway.app`
 * - raw endpoint: `https://…/v1/discovery/raw` (optional query)
 *
 * Explore-style callers use the base and append `/v1/discovery/…`.
 * Gateway `--token` / SignerSession callers use the raw endpoint as-is.
 */

export const DISCOVERY_RAW_PATH = "/v1/discovery/raw";

const ENV_KEYS = [
  "DISCOVERY_URL",
  "DISCOVERY_SERVICE_URL",
  "LIVEPEER_DISCOVERY_SERVICE_URL",
  "ORCH_WEBHOOK_URL",
] as const;

/** First non-empty configured discovery URL (any accepted shape). */
export function readConfiguredDiscoveryUrl(
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  for (const key of ENV_KEYS) {
    const value = env[key]?.trim();
    if (value) return value;
  }
  return undefined;
}

/**
 * Normalize to discovery-service origin (no `/v1/discovery…`, no query/hash).
 * Trailing slashes on the origin path are stripped.
 */
export function normalizeDiscoveryServiceBaseUrl(input: string): string {
  const url = new URL(input.trim());
  const discoveryIdx = url.pathname.indexOf("/v1/discovery");
  if (discoveryIdx >= 0) {
    url.pathname = url.pathname.slice(0, discoveryIdx) || "/";
  }
  url.search = "";
  url.hash = "";
  const path = url.pathname.replace(/\/+$/, "");
  return path && path !== "/" ? `${url.origin}${path}` : url.origin;
}

/**
 * Full GET endpoint for orchestrator lists (python-gateway / orch webhook).
 * Preserves query string when the configured URL already targeted raw.
 */
export function resolveDiscoveryRawUrl(input: string): string {
  const trimmed = input.trim();
  const parsed = new URL(trimmed);
  const base = normalizeDiscoveryServiceBaseUrl(trimmed);
  const path = parsed.pathname.replace(/\/+$/, "") || "/";
  const search =
    path === DISCOVERY_RAW_PATH || path.endsWith(DISCOVERY_RAW_PATH)
      ? parsed.search
      : "";
  return `${base}${DISCOVERY_RAW_PATH}${search}`;
}

/** Base URL for appending `/v1/discovery/capabilities` etc. */
export function getDiscoveryServiceBaseUrl(
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const configured = readConfiguredDiscoveryUrl(env);
  return configured ? normalizeDiscoveryServiceBaseUrl(configured) : undefined;
}

/**
 * Raw discovery endpoint for SignerSession.discovery_url and python-gateway tokens.
 */
export function getDiscoveryRawUrl(
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const configured = readConfiguredDiscoveryUrl(env);
  return configured ? resolveDiscoveryRawUrl(configured) : undefined;
}
