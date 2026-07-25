/**
 * Network pipeline catalog from Livepeer discovery-service raw.
 *
 * GET DISCOVERY_URL (`…/v1/discovery/raw`) → orchestrator rows with
 * `capabilities[]`, aggregated into pipeline/model catalog entries for
 * Plans / Network discovery UI and app manifests.
 */

import { getDiscoveryRawUrl } from "@/lib/discovery-service-url";

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

export interface PricingRow {
  orchAddress: string;
  orchName?: string;
  pipeline: string;
  model: string;
  /** Wei per pricing unit as a bigint-compatible string. */
  priceWeiPerUnit: string;
  /** Pixels per pricing unit as a bigint-compatible string. */
  pixelsPerUnit: string;
  isWarm?: boolean;
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
 * Aggregate discovery-service raw orch rows into catalog entries.
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

async function fetchDiscoveryRawJson(): Promise<unknown> {
  const url = getDiscoveryRawUrl();
  if (!url) {
    throw new Error(
      "DISCOVERY_URL (or DISCOVERY_SERVICE_URL) is not configured",
    );
  }

  let lastErr: unknown;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetch(url, {
        headers: { Accept: "application/json" },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (!res.ok) {
        throw new Error(`Discovery raw returned HTTP ${res.status}`);
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
        `Discovery raw timed out after ${REQUEST_TIMEOUT_MS}ms`,
      );
    }
    throw new Error(`Discovery raw failed: ${lastErr.message}`);
  }
  throw new Error("Discovery raw failed");
}

/** Fetch (and cache) the network pipeline catalog from discovery-service raw. */
export async function fetchPipelineCatalog(): Promise<PipelineCatalogEntry[]> {
  if (fetchPipelineCatalogForTests) {
    return fetchPipelineCatalogForTests();
  }
  if (catalogCache && catalogCache.expiresAt > Date.now()) {
    return catalogCache.data;
  }
  const raw = await fetchDiscoveryRawJson();
  const entries = catalogFromDiscoveryRaw(raw);
  catalogCache = { data: entries, expiresAt: Date.now() + CATALOG_TTL_MS };
  return entries;
}

/**
 * Per-orchestrator pricing rows. Discovery raw has no pricing payload;
 * returns an empty list (kept for API compatibility).
 */
export async function fetchDashboardPricing(): Promise<PricingRow[]> {
  return [];
}

/**
 * Find pricing rows that match a pipeline/model, optionally filtered to a
 * specific orchestrator address.  Returns only valid rows.
 */
export function filterPricingRows(
  rows: PricingRow[],
  pipeline: string,
  model: string,
  orchAddress?: string,
): PricingRow[] {
  return rows.filter((r) => {
    if (r.pipeline !== pipeline || r.model !== model) return false;
    if (
      orchAddress &&
      r.orchAddress.toLowerCase() !== orchAddress.toLowerCase()
    ) {
      return false;
    }
    return true;
  });
}
