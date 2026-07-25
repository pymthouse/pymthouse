/**
 * Livepeer discovery-service URL for SignerSession / python-gateway `--token`.
 *
 * Configure the full raw endpoint (optional query), e.g.
 * `https://discovery-service-production-8955.up.railway.app/v1/discovery/raw`
 * Returned as-is (trimmed). No path rewriting.
 */

const ENV_KEYS = [
  "DISCOVERY_URL",
  "DISCOVERY_SERVICE_URL",
  "LIVEPEER_DISCOVERY_SERVICE_URL",
  "ORCH_WEBHOOK_URL",
] as const;

export function getDiscoveryRawUrl(
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  for (const key of ENV_KEYS) {
    const value = env[key]?.trim();
    if (value) return value;
  }
  return undefined;
}
