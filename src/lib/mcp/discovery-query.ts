/**
 * Client-side ranking/filtering of the node `livepeer-discovery` document
 * served by the builder-engine discovery service (`GET /discovery`).
 *
 * The legacy `discovery-service` answered `POST /v1/discovery/query` with
 * pre-filtered, pre-ranked leaderboards. After the cutover, PymtHouse
 * reads the raw node array and does the filtering/ranking itself, matching
 * what `livepeer-builder-core`'s `HttpDiscoverySource` + `DiscoveryService`
 * does internally.
 *
 * All helpers here are pure (no I/O) so they are trivially unit-testable.
 */

import {
  capabilityAllowKeys,
  isCapabilityAllowed,
  type ManifestCapability,
} from "@/lib/mcp/capability-allow";

export interface DiscoveryRunner {
  url?: string;
  app?: string;
  mode?: string;
  version?: string;
  capacity?: number;
  capacityUsed?: number;
  capacityAvailable?: number;
  observedAt?: string;
  priceInfo?: {
    price?: number;
    priceUsd?: number;
    currency?: string;
    unit?: string;
  };
  [key: string]: unknown;
}

export interface DiscoveryDocumentEntry {
  address?: string;
  nodes?: unknown;
  runners?: DiscoveryRunner[];
  [key: string]: unknown;
}

export type SortBy = "avail" | "price" | "latency" | "swapRate";

export interface QueryOrchestratorsOptions {
  /** Capability names to match against each runner's `app`. */
  capabilities?: string[];
  /** Limit the result size. */
  topN?: number;
  /** Ranking key (default `"avail"`). */
  sortBy?: SortBy;
  /** Service-type filter; node runners have no service type, so this is advisory only. */
  serviceTypes?: string[];
  /** App manifest capability allowlist used to gate which capabilities may be requested. */
  manifestCapabilities?: ManifestCapability[];
  /**
   * Pre-filtered capability list (already allowlist-checked by the caller,
   * e.g. `filterAllowedCapabilities`). When provided, `queryNodeDiscovery`
   * uses it directly and skips the internal re-filter, so the allowlist
   * check happens exactly once.
   */
  filteredCapabilities?: string[];
  /**
   * Capabilities the manifest allowlist rejected. Set by the caller so the
   * result's `droppedCapabilities` is accurate without re-deriving it.
   */
  droppedCapabilities?: string[];
}

export interface QueryOrchestratorsResult {
  /** Runners kept after capability filtering + topN. */
  results: DiscoveryRunner[];
  /** Requested capability names that passed the manifest allowlist. */
  filteredCapabilities: string[];
  /** Requested capability names rejected by the manifest allowlist. */
  droppedCapabilities: string[];
  /** How many runners were dropped by topN. */
  truncated: number;
  /** The largest `observed_at` across the kept runners (RFC 3339 string), or null. */
  freshestObservedAt: string | null;
}

/** Flatten a node `livepeer-discovery` document into a single runner list. */
export function flattenDiscoveryDocument(document: unknown): DiscoveryRunner[] {
  if (!Array.isArray(document)) {
    throw new TypeError("discovery document must be a JSON array");
  }
  const out: DiscoveryRunner[] = [];
  for (const entry of document as DiscoveryDocumentEntry[]) {
    for (const runner of entry.runners ?? []) {
      out.push(runner);
    }
  }
  return out;
}

/**
 * Keep runners whose `app` capability matches at least one requested
 * capability. A runner's `app` is a capability name in the node schema
 * (e.g. `live/video-to-video`, `media/ffmpeg-live`).
 */
export function filterRunnersByCapabilities(
  runners: DiscoveryRunner[],
  capabilities: string[],
  manifestCapabilities?: ManifestCapability[],
): { kept: DiscoveryRunner[]; filteredCapabilities: string[]; droppedCapabilities: string[] } {
  const requested = (capabilities ?? []).map((c) => c.trim()).filter(Boolean);
  const allowKeys = manifestCapabilities ? capabilityAllowKeys(manifestCapabilities) : null;
  const filtered = allowKeys
    ? requested.filter((c) => isCapabilityAllowed(c, allowKeys))
    : requested;
  const dropped = requested.filter((c) => !filtered.includes(c));
  const wanted = new Set(filtered);
  const kept = runners.filter((r) => {
    const app = (r.app ?? "").trim();
    return app && wanted.has(app);
  });
  return { kept, filteredCapabilities: filtered, droppedCapabilities: dropped };
}


function parseStamp(stamp: string | undefined): number | null {
  if (!stamp) return null;
  const value = Date.parse(stamp);
  return Number.isFinite(value) ? value : null;
}

export function freshestObservedAt(runners: DiscoveryRunner[]): string | null {
  let best: { stamp: string; ms: number } | null = null;
  for (const runner of runners) {
    const ms = parseStamp(runner.observedAt);
    if (ms === null) continue;
    if (!best || ms > best.ms) {
      best = { stamp: runner.observedAt as string, ms };
    }
  }
  return best?.stamp ?? null;
}

/**
 * Rank runners client-side. Mirrors the legacy service's `sortBy` options:
 * - `avail` (default): highest `capacity_available` first, then cheapest.
 * - `price`: cheapest `price_info.price` first, then highest availability.
 * - `latency`: node runners carry no latency fields, so this degrades to `avail`.
 * - `swapRate`: node runners carry no swap fields, so this degrades to `price`.
 */
export interface RankRunnersResult {
  results: DiscoveryRunner[];
  truncated: number;
}

export function rankRunners(
  runners: DiscoveryRunner[],
  sortBy: SortBy = "avail",
  topN?: number,
): RankRunnersResult {
  const avail = (r: DiscoveryRunner): number => {
    const v = r.capacityAvailable;
    return typeof v === "number" && Number.isFinite(v) ? v : 0;
  };
  const price = (r: DiscoveryRunner): number => {
    const v = r.priceInfo?.price;
    return typeof v === "number" && Number.isFinite(v) ? v : 0;
  };

  // Stable sort + deterministic tie-break on `url` makes the result
  // reproducible when two runners tie on both primary and secondary keys
  // (e.g. two `text-to-image` runners with equal availability).
  const byPrice = sortBy === "price" || sortBy === "swapRate";
  const urlKey = (r: DiscoveryRunner): string => r.url ?? "";
  const copy = [...runners].sort((a, b) => {
    const primary = byPrice ? price(a) - price(b) : avail(b) - avail(a);
    const secondary = byPrice ? avail(b) - avail(a) : price(a) - price(b);
    const tie = urlKey(a) < urlKey(b) ? -1 : urlKey(a) > urlKey(b) ? 1 : 0;
    return primary || secondary || tie;
  });

  if (topN && topN > 0 && copy.length > topN) {
    return { results: copy.slice(0, topN), truncated: copy.length - topN };
  }
  return { results: copy, truncated: 0 };
}

/**
 * One-stop helper used by the `query_orchestrators` MCP tool:
 * fetch-free; pass it the raw node array.
 */
export function queryNodeDiscovery(
  document: unknown,
  options: QueryOrchestratorsOptions = {},
): QueryOrchestratorsResult {
  const runners = flattenDiscoveryDocument(document);

  // If the caller has already run the manifest allowlist check (e.g.
  // `filterAllowedCapabilities` in `hosted-server.ts`), reuse its output
  // and skip the internal re-filter so the allowlist check happens once.
  const preFiltered = options.filteredCapabilities;
  let kept: DiscoveryRunner[];
  let filteredCapabilities: string[];
  let droppedCapabilities: string[];
  if (preFiltered !== undefined) {
    const wanted = new Set(preFiltered.map((c) => c.trim()).filter(Boolean));
    kept = runners.filter((r) => {
      const app = (r.app ?? "").trim();
      return app && wanted.has(app);
    });
    filteredCapabilities = preFiltered;
    droppedCapabilities = options.droppedCapabilities ?? [];
  } else {
    const filtered = filterRunnersByCapabilities(
      runners,
      options.capabilities ?? [],
      options.manifestCapabilities,
    );
    kept = filtered.kept;
    filteredCapabilities = filtered.filteredCapabilities;
    droppedCapabilities = filtered.droppedCapabilities;
  }

  const ranked = rankRunners(kept, options.sortBy ?? "avail", options.topN);
  return {
    results: ranked.results,
    filteredCapabilities,
    droppedCapabilities,
    truncated: ranked.truncated,
    freshestObservedAt: freshestObservedAt(ranked.results),
  };
}

/**
 * Derive a legacy-compatible freshness object from the node array.
 *
 * Legacy `/v1/discovery/freshness` returned `{ ageMs, capabilityCount,
 * populated, refreshedAt, refreshedBy, totalRows }`. The node document has
 * per-runner `observed_at` stamps; we report the freshest stamp as the
 * dataset's observation time and count distinct apps as the capability count.
 */
export interface DiscoveryFreshness {
  freshestObservedAt: string | null;
  ageMs: number | null;
  capabilityCount: number;
  totalRunners: number;
  orchestratorCount: number;
  populated: boolean;
}

export function discoveryFreshnessFromDocument(
  document: unknown,
  nowMs: number = Date.now(),
): DiscoveryFreshness {
  const runners = flattenDiscoveryDocument(document);
  const apps = new Set<string>();
  for (const r of runners) {
    const app = (r.app ?? "").trim();
    if (app) apps.add(app);
  }
  const freshest = freshestObservedAt(runners);
  const ageMs = freshest !== null ? Math.max(0, nowMs - (parseStamp(freshest) ?? nowMs)) : null;
  const orchestratorCount = Array.isArray(document)
    ? (document as DiscoveryDocumentEntry[]).filter(
        (e) => Array.isArray(e.runners) && e.runners.length > 0,
      ).length
    : 0;
  return {
    freshestObservedAt: freshest,
    ageMs,
    capabilityCount: apps.size,
    totalRunners: runners.length,
    orchestratorCount,
    populated: runners.length > 0,
  };
}
