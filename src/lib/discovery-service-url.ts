/**
 * Remote-signer discovery URL: `{signer_url}/discover-orchestrators`.
 *
 * Matches go-livepeer remote discovery (`GET /discover-orchestrators`).
 * Optional repeated `caps` query params are applied by callers / gateways.
 */

/**
 * Build the discover-orchestrators URL for a remote signer base URL.
 * Appends `/discover-orchestrators` to the signer base path (path preserved).
 * Query strings and fragments are stripped so they cannot absorb the endpoint.
 */
export function buildDiscoverOrchestratorsUrl(signerUrl: string): string {
  const trimmed = signerUrl.trim();
  if (!trimmed) {
    throw new Error("signer URL is required to build discover-orchestrators URL");
  }

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error("signer URL must be an absolute http(s) URL");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("signer URL must be an http(s) URL");
  }

  parsed.search = "";
  parsed.hash = "";
  const basePath = parsed.pathname.replace(/\/+$/, "");
  parsed.pathname = `${basePath}/discover-orchestrators`;
  return parsed.toString();
}

/** Normalize caller-supplied capability strings for remote-signer `caps` filters. */
export function normalizeDiscoveryCaps(
  caps: readonly string[] | undefined | null,
): string[] | undefined {
  if (!caps?.length) return undefined;
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of caps) {
    if (typeof raw !== "string") continue;
    const cap = raw.trim();
    if (!cap || seen.has(cap)) continue;
    seen.add(cap);
    out.push(cap);
  }
  return out.length > 0 ? out : undefined;
}
