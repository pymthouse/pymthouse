/**
 * Network pipeline catalog from remote-signer discovery.
 *
 * GET `{signer}/discover-orchestrators` → orchestrator rows with
 * `capabilities[]`, aggregated into pipeline/model catalog entries for
 * Plans / Network discovery UI and app manifests.
 */

import { buildDiscoverOrchestratorsUrl } from "@/lib/discovery-service-url";
import { getClientSignerApiUrl } from "@/lib/signer-proxy";

const REQUEST_TIMEOUT_MS = Math.max(
  3000,
  Number.parseInt(process.env.DISCOVERY_CATALOG_REQUEST_TIMEOUT_MS ?? "15000", 10) ||
    15_000,
);

export interface PipelineCatalogEntry {
  id: string;
  name: string;
  models: string[];
  regions?: string[];
}

interface CacheEntry<T> {
  data: T;
  expiresAt: number;
}

const CATALOG_TTL_MS = 5 * 60 * 1000;

let catalogCache: CacheEntry<PipelineCatalogEntry[]> | null = null;

let fetchPipelineCatalogForTests: (() => Promise<PipelineCatalogEntry[]>) | null =
  null;

/** Route tests stub the catalog without Module loader hooks. */
export function setFetchPipelineCatalogForTests(
  fetcher: (() => Promise<PipelineCatalogEntry[]>) | null,
): void {
  fetchPipelineCatalogForTests = fetcher;
}

/** Split a capability into pipeline + model (`pipeline/model` or bare name). */
export function splitCapability(capability: string): {
  pipeline: string;
  model: string;
} | null {
  const trimmed = capability.trim();
  if (!trimmed) return null;
  const slash = trimmed.indexOf("/");
  if (slash <= 0 || slash === trimmed.length - 1) {
    return { pipeline: trimmed, model: trimmed };
  }
  return {
    pipeline: trimmed.slice(0, slash),
    model: trimmed.slice(slash + 1),
  };
}

/**
 * Aggregate discover-orchestrators rows into catalog entries.
 * Exported for unit tests.
 */
export function catalogFromDiscoveryRaw(raw: unknown): PipelineCatalogEntry[] {
  if (!Array.isArray(raw)) {
    throw new Error("Discovery raw response is not an array");
  }

  const byPipeline = new Map<string, Set<string>>();

  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const caps = (item as { capabilities?: unknown }).capabilities;
    if (!Array.isArray(caps)) continue;
    for (const cap of caps) {
      if (typeof cap !== "string") continue;
      const split = splitCapability(cap);
      if (!split) continue;
      let models = byPipeline.get(split.pipeline);
      if (!models) {
        models = new Set();
        byPipeline.set(split.pipeline, models);
      }
      models.add(split.model);
    }
  }

  const entries: PipelineCatalogEntry[] = [];
  for (const [id, models] of [...byPipeline.entries()].sort((a, b) =>
    a[0].localeCompare(b[0]),
  )) {
    entries.push({
      id,
      name: id,
      models: [...models].sort((a, b) => a.localeCompare(b)),
    });
  }
  return entries;
}

async function fetchDiscoveryJson(): Promise<unknown> {
  let url: string;
  try {
    url = buildDiscoverOrchestratorsUrl(getClientSignerApiUrl());
  } catch {
    throw new Error("Signer URL is not configured for pipeline catalog discovery");
  }

  let lastErr: unknown;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetch(url, {
        headers: { Accept: "application/json" },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (!res.ok) {
        throw new Error(`Discover-orchestrators returned HTTP ${res.status}`);
      }
      return res.json();
    } catch (err) {
      lastErr = err;
      if (attempt === 0) {
        await new Promise((r) => setTimeout(r, 250));
      }
    }
  }

  if (lastErr instanceof Error) {
    if (
      lastErr.name === "TimeoutError" ||
      lastErr.message.includes("aborted due to timeout")
    ) {
      throw new Error(
        `Discover-orchestrators timed out after ${REQUEST_TIMEOUT_MS}ms`,
      );
    }
    throw new Error(`Discover-orchestrators failed: ${lastErr.message}`);
  }
  throw new Error("Discover-orchestrators failed");
}

/** Fetch (and cache) the network pipeline catalog from remote-signer discovery. */
export async function fetchPipelineCatalog(): Promise<PipelineCatalogEntry[]> {
  if (fetchPipelineCatalogForTests) {
    return fetchPipelineCatalogForTests();
  }
  if (catalogCache && catalogCache.expiresAt > Date.now()) {
    return catalogCache.data;
  }
  const raw = await fetchDiscoveryJson();
  const entries = catalogFromDiscoveryRaw(raw);
  catalogCache = { data: entries, expiresAt: Date.now() + CATALOG_TTL_MS };
  return entries;
}
