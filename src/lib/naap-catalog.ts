/**
 * NaaP pipeline catalog and pricing client.
 *
 * Provides access to two NaaP endpoints:
 *  - /v1/dashboard/pipeline-catalog  → pipeline list with models (short TTL cache)
 *  - /v1/dashboard/pricing           → per-orchestrator pricing rows (uncached; each call fetches)
 *
 * Signing / `generate-live-payment` does not use this module for validation; it uses
 * the negotiated ticket facts from the request body (python-gateway + signer).
 */

const NAAP_API_BASE_URL =
  process.env.NAAP_API_BASE_URL?.replace(/\/+$/, "") ??
  "https://naap-api.cloudspe.com/v1";

const REQUEST_TIMEOUT_MS = 3000;

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

// ─── In-memory TTL cache (pipeline catalog only) ────────────────────────────

interface CacheEntry<T> {
  data: T;
  expiresAt: number;
}

const CATALOG_TTL_MS = 5 * 60 * 1000; // 5 minutes

let catalogCache: CacheEntry<PipelineCatalogEntry[]> | null = null;

// ─── Validation ──────────────────────────────────────────────────────────────

function parseCatalogEntry(raw: unknown, index: number): PipelineCatalogEntry | null {
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
  return { id, name, models, regions };
}

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

// ─── HTTP helpers ─────────────────────────────────────────────────────────────

async function naapGet(path: string): Promise<unknown> {
  const url = `${NAAP_API_BASE_URL}${path}`;
  const res = await fetch(url, {
    headers: { Accept: "application/json" },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!res.ok) {
    throw new Error(`NaaP API ${path} returned ${res.status}`);
  }
  return res.json();
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

// ─── Public API ───────────────────────────────────────────────────────────────

/** Fetch (and cache) the NaaP pipeline catalog. */
export async function fetchPipelineCatalog(): Promise<PipelineCatalogEntry[]> {
  if (catalogCache && catalogCache.expiresAt > Date.now()) {
    return catalogCache.data;
  }
  const raw = await naapGet("/dashboard/pipeline-catalog");
  if (!Array.isArray(raw)) {
    throw new Error("NaaP pipeline-catalog response is not an array");
  }
  const entries: PipelineCatalogEntry[] = [];
  for (let i = 0; i < raw.length; i++) {
    const entry = parseCatalogEntry(raw[i], i);
    if (entry) entries.push(entry);
  }
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
