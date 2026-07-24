/**
 * Pipeline catalog + NaaP pricing client.
 *
 * Catalog: discovery-service `GET /v1/discovery/capabilities` (short TTL cache),
 * adapted into the Plans UI `{ id, name, models[] }` shape.
 * Pricing: NaaP `/v1/dashboard/pricing` (uncached; each call fetches).
 *
 * Signing / `generate-live-payment` does not use this module for validation; it uses
 * the negotiated ticket facts from the request body (python-gateway + signer).
 */

function resolveNaapApiBaseUrl(): string {
  const explicit = process.env.NAAP_API_BASE_URL?.trim().replace(/\/+$/, "");
  if (explicit) {
    return explicit;
  }
  const nextAuth = process.env.NEXTAUTH_URL?.trim().replace(/\/+$/, "");
  if (
    process.env.NODE_ENV === "development" &&
    nextAuth &&
    /localhost|127\.0\.0\.1/i.test(nextAuth)
  ) {
    const u = new URL(nextAuth);
    const port = u.port || (u.protocol === "https:" ? "443" : "3000");
    const portSuffix =
      port && port !== "443" && port !== "80" ? `:${port}` : "";
    return `${u.protocol}//${u.hostname}${portSuffix}/api/v1`;
  }
  return "https://naap-api.cloudspe.com/v1";
}

function resolveDiscoveryServiceUrl(): string {
  const explicit =
    process.env.DISCOVERY_SERVICE_URL?.trim().replace(/\/+$/, "") ||
    process.env.DISCOVERY_SERVICE_BASE_URL?.trim().replace(/\/+$/, "");
  if (explicit) {
    return explicit;
  }
  return "https://discovery-service-production-8955.up.railway.app";
}

const NAAP_API_BASE_URL = resolveNaapApiBaseUrl();
const DISCOVERY_SERVICE_URL = resolveDiscoveryServiceUrl();

const REQUEST_TIMEOUT_MS = Math.max(
  3000,
  Number.parseInt(process.env.NAAP_CATALOG_REQUEST_TIMEOUT_MS ?? "15000", 10) || 15_000,
);

/** Service classes fetched for the Plans / manifest catalog. */
export const DISCOVERY_CATALOG_SERVICE_TYPES = [
  "live-video-to-video",
  "live-runner",
  "modules",
  "batch",
] as const;

export type DiscoveryCatalogServiceType = (typeof DISCOVERY_CATALOG_SERVICE_TYPES)[number];

// ─── Types ──────────────────────────────────────────────────────────────────

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

export interface DiscoveryCapabilityEntry {
  serviceType: string;
  capability: string;
  offeringIds?: string[];
}

// ─── In-memory TTL cache (pipeline catalog only) ────────────────────────────

interface CacheEntry<T> {
  data: T;
  expiresAt: number;
}

const CATALOG_TTL_MS = 5 * 60 * 1000; // 5 minutes

let catalogCache: CacheEntry<PipelineCatalogEntry[]> | null = null;

// ─── Validation ──────────────────────────────────────────────────────────────

function parsePricingRow(raw: unknown): PricingRow | null {
  if (typeof raw !== "object" || raw === null) return null;
  const r = raw as Record<string, unknown>;
  const orchAddress = typeof r.orchAddress === "string" ? r.orchAddress.trim() : "";
  const pipeline = typeof r.pipeline === "string" ? r.pipeline.trim() : "";
  const model = typeof r.model === "string" ? r.model.trim() : "";
  if (!orchAddress || !pipeline || !model) return null;

  const rawPrice = r.priceWeiPerUnit ?? r.price_wei_per_unit;
  const rawPixels = r.pixelsPerUnit ?? r.pixels_per_unit;

  const priceWeiPerUnit =
    typeof rawPrice === "string" || typeof rawPrice === "number"
      ? String(rawPrice).trim()
      : null;
  const pixelsPerUnit =
    typeof rawPixels === "string" || typeof rawPixels === "number"
      ? String(rawPixels).trim()
      : null;

  if (!priceWeiPerUnit || !pixelsPerUnit) return null;

  // Validate that both values are positive BigInt-compatible integers
  try {
    const price = BigInt(priceWeiPerUnit);
    const pixels = BigInt(pixelsPerUnit);
    if (price <= 0n || pixels <= 0n) return null;
  } catch {
    return null;
  }

  return {
    orchAddress,
    orchName: typeof r.orchName === "string" ? r.orchName : undefined,
    pipeline,
    model,
    priceWeiPerUnit,
    pixelsPerUnit,
    isWarm: typeof r.isWarm === "boolean" ? r.isWarm : undefined,
  };
}

function parseDiscoveryCapabilityEntry(raw: unknown): DiscoveryCapabilityEntry | null {
  if (typeof raw !== "object" || raw === null) return null;
  const r = raw as Record<string, unknown>;
  const serviceType =
    typeof r.serviceType === "string" && r.serviceType.trim()
      ? r.serviceType.trim()
      : null;
  const capability =
    typeof r.capability === "string" && r.capability.trim()
      ? r.capability.trim()
      : null;
  if (!serviceType || !capability) return null;
  const offeringIds = Array.isArray(r.offeringIds)
    ? (r.offeringIds as unknown[])
        .filter((id): id is string => typeof id === "string" && id.trim() !== "")
        .map((id) => id.trim())
    : undefined;
  return {
    serviceType,
    capability,
    offeringIds: offeringIds?.length ? offeringIds : undefined,
  };
}

function parseDiscoveryCapabilitiesResponse(raw: unknown): DiscoveryCapabilityEntry[] {
  if (typeof raw !== "object" || raw === null) {
    throw new Error("Discovery capabilities response is not an object");
  }
  const r = raw as Record<string, unknown>;
  if (Array.isArray(r.entries) && r.entries.length > 0) {
    const entries: DiscoveryCapabilityEntry[] = [];
    for (const item of r.entries) {
      const entry = parseDiscoveryCapabilityEntry(item);
      if (entry) entries.push(entry);
    }
    return entries;
  }
  // Fallback when `entries` is omitted: treat bare capability names as live-video-to-video.
  if (Array.isArray(r.capabilities)) {
    return (r.capabilities as unknown[])
      .filter((c): c is string => typeof c === "string" && c.trim() !== "")
      .map((capability) => ({
        serviceType: "live-video-to-video",
        capability: capability.trim(),
      }));
  }
  return [];
}

function humanizeCatalogLabel(raw: string): string {
  return raw
    .split(/[-_./:]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function ensureCatalogBucket(
  grouped: Map<string, { name: string; models: Set<string> }>,
  id: string,
): { name: string; models: Set<string> } {
  let bucket = grouped.get(id);
  if (!bucket) {
    bucket = { name: humanizeCatalogLabel(id), models: new Set() };
    grouped.set(id, bucket);
  }
  return bucket;
}

function addModelsToBucket(
  bucket: { models: Set<string> },
  models: string[],
): void {
  for (const model of models) {
    if (model) bucket.models.add(model);
  }
}

/**
 * Adapt discovery-service capabilities into the Plans `{pipeline, models[]}` catalog.
 *
 * Contract notes vs retired NaaP `/dashboard/pipeline-catalog`:
 * - Discovery returns capability names (often bare model / app IDs), not nested pipeline rows.
 * - `live-video-to-video`, `live-runner`, and `batch` group under `serviceType` as the pipeline id
 *   (preserves historical `live-video-to-video` + model billing keys).
 * - `modules` use capability as pipeline id and `offeringIds` as models.
 * - Batch pipeline prefixes (`text-to-image/...`) are stripped upstream; catalog id is `batch`.
 * - `serviceType=legacy` is no longer valid; use `live-video-to-video` (invalid values fall back
 *   to discovery-service defaults of live-video-to-video + live-runner).
 */
export function mapDiscoveryCapabilitiesToCatalog(
  entries: DiscoveryCapabilityEntry[],
): PipelineCatalogEntry[] {
  const grouped = new Map<string, { name: string; models: Set<string> }>();

  for (const entry of entries) {
    const serviceType = entry.serviceType.trim();
    const capability = entry.capability.trim();
    if (!serviceType || !capability) continue;

    if (serviceType === "modules") {
      const models =
        entry.offeringIds && entry.offeringIds.length > 0
          ? entry.offeringIds
          : [capability];
      addModelsToBucket(ensureCatalogBucket(grouped, capability), models);
      continue;
    }

    addModelsToBucket(ensureCatalogBucket(grouped, serviceType), [capability]);
  }

  return [...grouped.entries()]
    .map(([id, { name, models }]) => ({
      id,
      name,
      models: [...models].sort((a, b) => a.localeCompare(b)),
    }))
    .filter((e) => e.models.length > 0)
    .sort((a, b) => a.id.localeCompare(b.id));
}

// ─── HTTP helpers ─────────────────────────────────────────────────────────────

function mapFetchError(label: string, path: string, err: unknown): Error {
  if (err instanceof Error) {
    if (err.name === "TimeoutError" || err.message.includes("aborted due to timeout")) {
      return new Error(
        `${label} ${path} timed out after ${REQUEST_TIMEOUT_MS}ms`,
      );
    }
    return new Error(`${label} ${path} failed: ${err.message}`);
  }
  return new Error(`${label} ${path} failed`);
}

async function jsonGet(baseUrl: string, path: string, label: string): Promise<unknown> {
  const url = `${baseUrl}${path}`;
  let lastErr: unknown;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetch(url, {
        headers: { Accept: "application/json" },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (!res.ok) {
        throw new Error(`${label} ${path} returned ${res.status}`);
      }
      return res.json();
    } catch (err) {
      lastErr = err;
      if (attempt === 0) {
        await new Promise((r) => setTimeout(r, 250));
      }
    }
  }
  throw mapFetchError(label, path, lastErr);
}

async function naapGet(path: string): Promise<unknown> {
  return jsonGet(NAAP_API_BASE_URL, path, "NaaP API");
}

async function discoveryGet(path: string): Promise<unknown> {
  return jsonGet(DISCOVERY_SERVICE_URL, path, "Discovery Service");
}

async function fetchDashboardPricingFromNetwork(): Promise<PricingRow[]> {
  const raw = await naapGet("/dashboard/pricing");
  if (!Array.isArray(raw)) {
    throw new Error("NaaP pricing response is not an array");
  }
  const rows: PricingRow[] = [];
  for (const item of raw) {
    const row = parsePricingRow(item);
    if (row) rows.push(row);
  }
  return rows;
}

async function fetchDiscoveryCatalogFromNetwork(): Promise<PipelineCatalogEntry[]> {
  const settled = await Promise.all(
    DISCOVERY_CATALOG_SERVICE_TYPES.map(async (serviceType) => {
      const raw = await discoveryGet(
        `/v1/discovery/capabilities?serviceType=${encodeURIComponent(serviceType)}`,
      );
      return parseDiscoveryCapabilitiesResponse(raw);
    }),
  );
  return mapDiscoveryCapabilitiesToCatalog(settled.flat());
}

// ─── Public API ───────────────────────────────────────────────────────────────

/** Fetch (and cache) the discovery-service pipeline catalog. */
let fetchPipelineCatalogForTests: (() => Promise<PipelineCatalogEntry[]>) | null = null;

/** Route tests stub the catalog without Module loader hooks. */
export function setFetchPipelineCatalogForTests(
  fetcher: (() => Promise<PipelineCatalogEntry[]>) | null,
): void {
  fetchPipelineCatalogForTests = fetcher;
}

export async function fetchPipelineCatalog(): Promise<PipelineCatalogEntry[]> {
  if (fetchPipelineCatalogForTests) {
    return fetchPipelineCatalogForTests();
  }
  if (catalogCache && catalogCache.expiresAt > Date.now()) {
    return catalogCache.data;
  }
  const entries = await fetchDiscoveryCatalogFromNetwork();
  catalogCache = { data: entries, expiresAt: Date.now() + CATALOG_TTL_MS };
  return entries;
}

/** Fetch NaaP per-orchestrator pricing rows (always hits NaaP; no in-process cache). */
export async function fetchDashboardPricing(): Promise<PricingRow[]> {
  return fetchDashboardPricingFromNetwork();
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
    if (orchAddress && r.orchAddress.toLowerCase() !== orchAddress.toLowerCase()) return false;
    return true;
  });
}
