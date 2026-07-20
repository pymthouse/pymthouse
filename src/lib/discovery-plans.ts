/**
 * App-scoped discovery policy stored on PymtHouse plans.
 * Field names align with NaaP Orchestrator Leaderboard CreatePlanInput (for-ai.md).
 */

export type DiscoverySortBy = "latency" | "price" | "swapRate" | "avail";

export interface DiscoveryPolicyFilters {
  gpuRamGbMin?: number;
  gpuRamGbMax?: number;
  priceMax?: number;
  maxAvgLatencyMs?: number;
  maxSwapRatio?: number;
}

export interface DiscoveryPolicy {
  topN?: number;
  sortBy?: DiscoverySortBy;
  filters?: DiscoveryPolicyFilters;
}

const SORT_BY_VALUES: DiscoverySortBy[] = ["latency", "price", "swapRate", "avail"];

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function parseNonNegativeNumber(
  raw: unknown,
  path: string,
): { ok: true; value: number } | { ok: false; error: string } {
  const n = typeof raw === "number" ? raw : Number(String(raw).trim());
  if (!Number.isFinite(n) || n < 0) {
    return { ok: false, error: `${path} must be a non-negative number` };
  }
  return { ok: true, value: n };
}

function parseRatio(raw: unknown, path: string): { ok: true; value: number } | { ok: false; error: string } {
  const n = typeof raw === "number" ? raw : Number(String(raw).trim());
  if (!Number.isFinite(n) || n < 0 || n > 1) {
    return { ok: false, error: `${path} must be a number between 0 and 1` };
  }
  return { ok: true, value: n };
}

function parseTopN(raw: unknown): { ok: true; value: number } | { ok: false; error: string } {
  const n = typeof raw === "number" ? raw : Number(String(raw).trim());
  if (!Number.isInteger(n) || n < 1 || n > 1000) {
    return { ok: false, error: "topN must be an integer between 1 and 1000" };
  }
  return { ok: true, value: n };
}

function assignOptionalNonNegative(
  target: DiscoveryPolicyFilters,
  key: keyof DiscoveryPolicyFilters,
  raw: unknown,
  path: string,
): { ok: true } | { ok: false; error: string } {
  if (raw === undefined) return { ok: true };
  const v = parseNonNegativeNumber(raw, path);
  if (!v.ok) return v;
  target[key] = v.value;
  return { ok: true };
}

function parseDiscoveryFilters(
  rawFilters: unknown,
  pathPrefix: string,
): { ok: true; filters: DiscoveryPolicyFilters | undefined } | { ok: false; error: string } {
  if (!isPlainObject(rawFilters)) {
    return { ok: false, error: `${pathPrefix}.filters must be an object` };
  }
  const f: DiscoveryPolicyFilters = {};
  const fl = rawFilters;

  for (const [key, path] of [
    ["gpuRamGbMin", `${pathPrefix}.filters.gpuRamGbMin`],
    ["gpuRamGbMax", `${pathPrefix}.filters.gpuRamGbMax`],
    ["priceMax", `${pathPrefix}.filters.priceMax`],
    ["maxAvgLatencyMs", `${pathPrefix}.filters.maxAvgLatencyMs`],
  ] as const) {
    const assigned = assignOptionalNonNegative(f, key, fl[key], path);
    if (!assigned.ok) return assigned;
  }

  if (fl.maxSwapRatio !== undefined) {
    const v = parseRatio(fl.maxSwapRatio, `${pathPrefix}.filters.maxSwapRatio`);
    if (!v.ok) return { ok: false, error: v.error };
    f.maxSwapRatio = v.value;
  }

  if (
    f.gpuRamGbMin !== undefined &&
    f.gpuRamGbMax !== undefined &&
    f.gpuRamGbMin > f.gpuRamGbMax
  ) {
    return {
      ok: false,
      error: `${pathPrefix}.filters: gpuRamGbMin must be <= gpuRamGbMax`,
    };
  }

  return {
    ok: true,
    filters: Object.keys(f).length > 0 ? f : undefined,
  };
}

/**
 * Parse and validate a discovery policy object.
 * `null` / `undefined` input → success with `policy: null` (clear / omit).
 */
export function parseDiscoveryPolicyInput(
  raw: unknown,
  pathPrefix: string,
): { ok: true; policy: DiscoveryPolicy | null } | { ok: false; error: string } {
  if (raw === undefined || raw === null) {
    return { ok: true, policy: null };
  }
  if (!isPlainObject(raw)) {
    return { ok: false, error: `${pathPrefix} must be an object or null` };
  }

  const out: DiscoveryPolicy = {};

  if (raw.topN !== undefined) {
    const t = parseTopN(raw.topN);
    if (!t.ok) return { ok: false, error: `${pathPrefix}.topN: ${t.error}` };
    out.topN = t.value;
  }

  if (raw.sortBy !== undefined) {
    const s = String(raw.sortBy).trim() as DiscoverySortBy;
    if (!SORT_BY_VALUES.includes(s)) {
      return {
        ok: false,
        error: `${pathPrefix}.sortBy must be one of: ${SORT_BY_VALUES.join(", ")}`,
      };
    }
    out.sortBy = s;
  }

  if (raw.filters !== undefined) {
    const parsed = parseDiscoveryFilters(raw.filters, pathPrefix);
    if (!parsed.ok) return parsed;
    if (parsed.filters) out.filters = parsed.filters;
  }

  if (Object.keys(out).length === 0) {
    return { ok: true, policy: null };
  }
  return { ok: true, policy: out };
}

/** Normalize DB JSON (unknown) to DiscoveryPolicy | null. */
export function discoveryPolicyFromDb(raw: unknown): DiscoveryPolicy | null {
  if (raw === null || raw === undefined) return null;
  if (!isPlainObject(raw)) return null;
  const parsed = parseDiscoveryPolicyInput(raw, "discoveryPolicy");
  return parsed.ok ? parsed.policy : null;
}

function mergeOptionalMax(
  appVal: number | undefined,
  userVal: number | undefined,
): number | undefined {
  if (appVal !== undefined && userVal !== undefined) return Math.min(appVal, userVal);
  if (userVal !== undefined) return userVal;
  if (appVal !== undefined) return appVal;
  return undefined;
}

function mergeDiscoveryFilters(
  af: DiscoveryPolicyFilters | undefined,
  uf: DiscoveryPolicyFilters | undefined,
): DiscoveryPolicyFilters | undefined {
  if (!af && !uf) return undefined;

  const f: DiscoveryPolicyFilters = {};
  const gminA = af?.gpuRamGbMin;
  const gminU = uf?.gpuRamGbMin;
  if (gminA !== undefined || gminU !== undefined) {
    f.gpuRamGbMin = Math.max(gminA ?? 0, gminU ?? 0);
  }

  const gmax = mergeOptionalMax(af?.gpuRamGbMax, uf?.gpuRamGbMax);
  if (gmax !== undefined) f.gpuRamGbMax = gmax;

  const priceMax = mergeOptionalMax(af?.priceMax, uf?.priceMax);
  if (priceMax !== undefined) f.priceMax = priceMax;

  const latency = mergeOptionalMax(af?.maxAvgLatencyMs, uf?.maxAvgLatencyMs);
  if (latency !== undefined) f.maxAvgLatencyMs = latency;

  const swap = mergeOptionalMax(af?.maxSwapRatio, uf?.maxSwapRatio);
  if (swap !== undefined) f.maxSwapRatio = swap;

  return Object.keys(f).length > 0 ? f : undefined;
}

/**
 * Conservative merge: app policy is an upper bound; user refines within it.
 * Used by integrators (e.g. NaaP) when combining app plan defaults with user preferences.
 */
export function mergeDiscoveryPolicies(
  app: DiscoveryPolicy | null,
  user: DiscoveryPolicy | null,
): DiscoveryPolicy | null {
  if (!app && !user) return null;
  if (!app) return user ? { ...user } : null;
  if (!user) return { ...app };

  const out: DiscoveryPolicy = { ...app };

  if (user.topN !== undefined) {
    const cap = app.topN ?? user.topN;
    out.topN = Math.min(cap, user.topN);
  }

  if (user.sortBy !== undefined) {
    out.sortBy = user.sortBy;
  }

  if (app.filters || user.filters) {
    const merged = mergeDiscoveryFilters(app.filters, user.filters);
    if (merged) out.filters = merged;
    else delete out.filters;
  }

  return out;
}
