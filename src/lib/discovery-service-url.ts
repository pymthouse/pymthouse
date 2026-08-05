/**
 * Remote-signer discovery URL: `{signer_url}/discover-orchestrators`.
 *
 * Matches go-livepeer remote discovery (`GET /discover-orchestrators`).
 * Optional repeated `caps` query params are applied by callers / gateways.
 */

function trimTrailingSlashes(value: string): string {
  let end = value.length;
  while (end > 0 && value[end - 1] === "/") {
    end -= 1;
  }
  return value.slice(0, end);
}

/**
 * Build the discover-orchestrators URL for a remote signer base URL.
 * Preserves an existing path on the signer origin (uses URL join on origin only).
 */
export function buildDiscoverOrchestratorsUrl(signerUrl: string): string {
  const trimmed = signerUrl.trim();
  if (!trimmed) {
    throw new Error("signer URL is required to build discover-orchestrators URL");
  }
  const base = trimTrailingSlashes(trimmed);
  return `${base}/discover-orchestrators`;
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
