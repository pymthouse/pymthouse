/**
 * Pipeline catalog and dashboard pricing client.
 *
 * Catalog (billing plans, manifest, discovery UI):
 *   Discovery Service `GET /v1/discovery/capabilities` — legacy + registry capabilities.
 *
 * Pricing (dashboard UI only; not used on the signing hot path):
 *   Legacy NaaP `GET /v1/dashboard/pricing` when `NAAP_API_BASE_URL` is set, otherwise
 *   derived from Discovery Service `POST /v1/discovery/query`.
 *
 * Signing / `generate-live-payment` does not use this module for validation; it uses
 * the negotiated ticket facts from the request body (python-gateway + signer).
 */

import type { CatalogServiceType } from "@/lib/signing-modes";

const DEFAULT_DISCOVERY_SERVICE_BASE_URL =
  "https://discovery-service-production-8955.up.railway.app";

const DEFAULT_NAAP_PRICING_BASE_URL = "https://naap-api.cloudspe.com/v1";

const LEGACY_OFFERING_PLACEHOLDER = "default";

function resolveDiscoveryServiceBaseUrl(): string {
  const explicit =
    process.env.DISCOVERY_SERVICE_BASE_URL?.trim().replace(/\/+$/, "") ??
    process.env.DISCOVERY_SERVICE_URL?.trim().replace(/\/+$/, "");
  if (explicit) return explicit;
  return DEFAULT_DISCOVERY_SERVICE_BASE_URL;
}

function resolveNaapPricingBaseUrl(): string | null {
  const explicit = process.env.NAAP_API_BASE_URL?.trim().replace(/\/+$/, "");
  if (explicit) return explicit;
  return DEFAULT_NAAP_PRICING_BASE_URL;
}

const DISCOVERY_SERVICE_BASE_URL = resolveDiscoveryServiceBaseUrl();
const NAAP_PRICING_BASE_URL = resolveNaapPricingBaseUrl();

const REQUEST_TIMEOUT_MS = Math.max(
  3000,
  Number.parseInt(process.env.NAAP_CATALOG_REQUEST_TIMEOUT_MS ?? "15000", 10) || 15_000,
);

// ─── Types ──────────────────────────────────────────────────────────────────

export interface PipelineCatalogEntry {
  id: string;
  name: string;
  models: string[];
  regions?: string[];
  /** `legacy` flat capability names vs `registry` capability:offering rows. */
  serviceType?: "legacy" | "registry";
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

interface DiscoveryCapabilityEntry {
  serviceType?: string;
  capability?: string;
  offeringIds?: string[];
}

// ─── In-memory TTL cache (pipeline catalog only) ────────────────────────────

interface CacheEntry<T> {
  data: T;
  expiresAt: number;
}

const CATALOG_TTL_MS = 5 * 60 * 1000; // 5 minutes

let fullCatalogCache: CacheEntry<PipelineCatalogEntry[]> | null = null;
let fetchPipelineCatalogForTests: (() => Promise<PipelineCatalogEntry[]>) | null = null;

async function fetchFullPipelineCatalog(): Promise<PipelineCatalogEntry[]> {
  if (fetchPipelineCatalogForTests) {
    return fetchPipelineCatalogForTests();
  }
  if (fullCatalogCache && fullCatalogCache.expiresAt > Date.now()) {
    return fullCatalogCache.data;
  }

  const raw = await discoveryGet("/v1/discovery/capabilities");
  const entries = catalogFromDiscoveryCapabilities(raw);
  fullCatalogCache = { data: entries, expiresAt: Date.now() + CATALOG_TTL_MS };
  return entries;
}

export interface FetchPipelineCatalogOptions {
  serviceType?: CatalogServiceType;
}

export async function fetchPipelineCatalog(
  options?: FetchPipelineCatalogOptions,
): Promise<PipelineCatalogEntry[]> {
  if (fetchPipelineCatalogForTests) {
    return fetchPipelineCatalogForTests();
  }
  const full = await fetchFullPipelineCatalog();
  const serviceType = options?.serviceType;
  if (!serviceType) {
    return full;
  }
  return filterCatalogByServiceType(full, serviceType);
}

/** Fetch per-orchestrator pricing rows for dashboard UI (uncached). */
export async function fetchDashboardPricing(
  options?: FetchPipelineCatalogOptions,
): Promise<PricingRow[]> {
  if (NAAP_PRICING_BASE_URL) {
    try {
      return await fetchDashboardPricingFromNaap();
    } catch (err) {
      console.warn(
        "[naap-catalog] NaaP pricing fetch failed; falling back to discovery query:",
        err instanceof Error ? err.message : err,
      );
    }
  }
  return fetchDashboardPricingFromDiscovery(options?.serviceType);
}

// ─── Validation ──────────────────────────────────────────────────────────────

function parseCatalogEntry(raw: unknown): PipelineCatalogEntry | null {
  if (typeof raw !== "object" || raw === null) return null;
  const r = raw as Record<string, unknown>;
  const id = typeof r.id === "string" && r.id.trim() ? r.id.trim() : null;
  const name = typeof r.name === "string" && r.name.trim() ? r.name.trim() : null;
  if (!id || !name) return null;
  const models = Array.isArray(r.models)
    ? (r.models as unknown[])
        .filter((m): m is string => typeof m === "string" && m.trim() !== "")
        .map((m) => m.trim())
    : [];
  const regions = Array.isArray(r.regions)
    ? (r.regions as unknown[])
        .filter((m): m is string => typeof m === "string" && m.trim() !== "")
        .map((m) => m.trim())
    : undefined;
  const serviceType =
    r.serviceType === "legacy" || r.serviceType === "registry"
      ? r.serviceType
      : undefined;
  return { id, name, models, regions, serviceType };
}

function parsePricingRow(raw: unknown): PricingRow | null {
  if (typeof raw !== "object" || raw === null) return null;
  const r = raw as Record<string, unknown>;
  const orchAddress = typeof r.orchAddress === "string" ? r.orchAddress.trim() : "";
  const pipeline = typeof r.pipeline === "string" ? r.pipeline.trim() : "";
  const model = typeof r.model === "string" ? r.model.trim() : "";
  if (!orchAddress || !pipeline || !model) return null;

  const rawPrice = r.priceWeiPerUnit ?? r.price_wei_per_unit ?? r.pricePerUnitWei;
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

/**
 * Convert Discovery Service `/v1/discovery/capabilities` into pipeline catalog rows.
 * Registry entries map capability → offeringIds; legacy entries use a single placeholder model.
 */
export function catalogFromDiscoveryCapabilities(raw: unknown): PipelineCatalogEntry[] {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error("Discovery capabilities response must be an object");
  }
  const entriesRaw = (raw as { entries?: unknown }).entries;
  if (!Array.isArray(entriesRaw)) {
    throw new Error("Discovery capabilities response missing entries array");
  }

  const byPipeline = new Map<
    string,
    { models: Set<string>; serviceType: "legacy" | "registry" }
  >();

  for (const item of entriesRaw) {
    if (typeof item !== "object" || item === null) continue;
    const entry = item as DiscoveryCapabilityEntry;
    const capability =
      typeof entry.capability === "string" ? entry.capability.trim() : "";
    if (!capability) continue;

    const serviceType =
      entry.serviceType === "registry" ? "registry" : "legacy";
    const bucket =
      byPipeline.get(capability) ??
      ({ models: new Set<string>(), serviceType } satisfies {
        models: Set<string>;
        serviceType: "legacy" | "registry";
      });

    if (serviceType === "registry") {
      bucket.serviceType = "registry";
      const offerings = Array.isArray(entry.offeringIds)
        ? entry.offeringIds.filter(
            (o): o is string => typeof o === "string" && o.trim() !== "",
          )
        : [];
      for (const offering of offerings) {
        bucket.models.add(offering.trim());
      }
    } else {
      bucket.models.add(LEGACY_OFFERING_PLACEHOLDER);
    }

    byPipeline.set(capability, bucket);
  }

  return [...byPipeline.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([id, { models, serviceType }]) => ({
      id,
      name: id,
      models: [...models].sort((a, b) => a.localeCompare(b)),
      serviceType,
    }));
}

export function filterCatalogByServiceType(
  catalog: PipelineCatalogEntry[],
  serviceType: CatalogServiceType,
): PipelineCatalogEntry[] {
  return catalog.filter((entry) => entry.serviceType === serviceType);
}

// ─── HTTP helpers ─────────────────────────────────────────────────────────────

function mapFetchError(label: string, err: unknown): Error {
  if (err instanceof Error) {
    if (err.name === "TimeoutError" || err.message.includes("aborted due to timeout")) {
      return new Error(
        `${label} timed out after ${REQUEST_TIMEOUT_MS}ms (set DISCOVERY_SERVICE_BASE_URL or NAAP_CATALOG_REQUEST_TIMEOUT_MS)`,
      );
    }
    return new Error(`${label} failed: ${err.message}`);
  }
  return new Error(`${label} failed`);
}

async function fetchJson(url: string, init?: RequestInit): Promise<unknown> {
  let lastErr: unknown;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetch(url, {
        ...init,
        headers: {
          Accept: "application/json",
          ...(init?.headers ?? {}),
        },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`);
      }
      return res.json();
    } catch (err) {
      lastErr = err;
      if (attempt === 0) {
        await new Promise((r) => setTimeout(r, 250));
      }
    }
  }
  throw lastErr;
}

async function discoveryGet(path: string): Promise<unknown> {
  const url = `${DISCOVERY_SERVICE_BASE_URL}${path}`;
  try {
    return await fetchJson(url);
  } catch (err) {
    throw mapFetchError(`Discovery Service ${path}`, err);
  }
}

async function naapPricingGet(path: string): Promise<unknown> {
  if (!NAAP_PRICING_BASE_URL) {
    throw new Error("NAAP pricing base URL is not configured");
  }
  const url = `${NAAP_PRICING_BASE_URL}${path}`;
  try {
    return await fetchJson(url);
  } catch (err) {
    throw mapFetchError(`NaaP API ${path}`, err);
  }
}

async function fetchDashboardPricingFromNaap(): Promise<PricingRow[]> {
  const raw = await naapPricingGet("/dashboard/pricing");
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

async function fetchDashboardPricingFromDiscovery(
  serviceType?: CatalogServiceType,
): Promise<PricingRow[]> {
  const catalog = await fetchPipelineCatalog(
    serviceType ? { serviceType } : undefined,
  );
  const capabilityIds = catalog.map((e) => e.id);
  if (!capabilityIds.length) return [];

  const raw = await fetchJson(`${DISCOVERY_SERVICE_BASE_URL}/v1/discovery/query`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      capabilities: capabilityIds,
      topN: 50,
      sortBy: "price",
    }),
  });

  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error("Discovery query response must be an object");
  }

  const results = (raw as { results?: unknown }).results;
  if (typeof results !== "object" || results === null || Array.isArray(results)) {
    throw new Error("Discovery query response missing results object");
  }

  const rows: PricingRow[] = [];
  for (const [capability, orchestrators] of Object.entries(
    results as Record<string, unknown>,
  )) {
    if (!capability.trim() || !Array.isArray(orchestrators)) continue;

    for (const orch of orchestrators) {
      if (typeof orch !== "object" || orch === null) continue;
      const o = orch as Record<string, unknown>;
      const ethAddress =
        typeof o.ethAddress === "string"
          ? o.ethAddress.trim()
          : typeof o.address === "string"
            ? o.address.trim()
            : "";
      const offeringId =
        typeof o.offeringId === "string" ? o.offeringId.trim() : LEGACY_OFFERING_PLACEHOLDER;
      const pricePerUnitWei =
        typeof o.pricePerUnitWei === "string" || typeof o.pricePerUnitWei === "number"
          ? String(o.pricePerUnitWei).trim()
          : "";
      if (!ethAddress || !pricePerUnitWei) continue;

      const row = parsePricingRow({
        orchAddress: ethAddress,
        pipeline: capability.trim(),
        model: offeringId,
        priceWeiPerUnit: pricePerUnitWei,
        pixelsPerUnit: "1",
      });
      if (row) rows.push(row);
    }
  }

  return rows;
}

// ─── Public API ───────────────────────────────────────────────────────────────

/** Route tests stub the catalog without Module loader hooks. */
export function setFetchPipelineCatalogForTests(
  fetcher: (() => Promise<PipelineCatalogEntry[]>) | null,
): void {
  fetchPipelineCatalogForTests = fetcher;
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
