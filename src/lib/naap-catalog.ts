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

function trimTrailingSlashes(value: string): string {
  let end = value.length;
  while (end > 0 && value.charCodeAt(end - 1) === 47 /* / */) {
    end -= 1;
  }
  return end === value.length ? value : value.slice(0, end);
}

function resolveNaapApiBaseUrl(): string {
  const explicitRaw = process.env.NAAP_API_BASE_URL?.trim();
  const explicit = explicitRaw ? trimTrailingSlashes(explicitRaw) : "";
  if (explicit) {
    return explicit;
  }
  const nextAuthRaw = process.env.NEXTAUTH_URL?.trim();
  const nextAuth = nextAuthRaw ? trimTrailingSlashes(nextAuthRaw) : "";
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

const NAAP_API_BASE_URL = resolveNaapApiBaseUrl();

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

function mapNaapFetchError(path: string, err: unknown): Error {
  if (err instanceof Error) {
    if (err.name === "TimeoutError" || err.message.includes("aborted due to timeout")) {
      return new Error(
        `NaaP API ${path} timed out after ${REQUEST_TIMEOUT_MS}ms (set NAAP_API_BASE_URL or NAAP_CATALOG_REQUEST_TIMEOUT_MS)`,
      );
    }
    return new Error(`NaaP API ${path} failed: ${err.message}`);
  }
  return new Error(`NaaP API ${path} failed`);
}

async function naapGet(path: string): Promise<unknown> {
  const url = `${NAAP_API_BASE_URL}${path}`;
  let lastErr: unknown;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetch(url, {
        headers: { Accept: "application/json" },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (!res.ok) {
        throw new Error(`NaaP API ${path} returned ${res.status}`);
      }
      return res.json();
    } catch (err) {
      lastErr = err;
      if (attempt === 0) {
        await new Promise((r) => setTimeout(r, 250));
      }
    }
  }
  throw mapNaapFetchError(path, lastErr);
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
