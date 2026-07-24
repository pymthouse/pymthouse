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
    if (typeof raw.sortBy !== "string") {
      return {
        ok: false,
        error: `${pathPrefix}.sortBy must be one of: ${SORT_BY_VALUES.join(", ")}`,
      };
    }
    const s = raw.sortBy.trim() as DiscoverySortBy;
    if (!SORT_BY_VALUES.includes(s)) {
      return {
        ok: false,
        error: `${pathPrefix}.sortBy must be one of: ${SORT_BY_VALUES.join(", ")}`,
      };
    }
    out.sortBy = s;
  }

  if (raw.filters !== undefined) {
    if (!isPlainObject(raw.filters)) {
      return { ok: false, error: `${pathPrefix}.filters must be an object` };
    }
    const f: DiscoveryPolicyFilters = {};
    const fl = raw.filters;
    if (fl.gpuRamGbMin !== undefined) {
      const v = parseNonNegativeNumber(fl.gpuRamGbMin, `${pathPrefix}.filters.gpuRamGbMin`);
      if (!v.ok) return { ok: false, error: v.error };
      f.gpuRamGbMin = v.value;
    }
    if (fl.gpuRamGbMax !== undefined) {
      const v = parseNonNegativeNumber(fl.gpuRamGbMax, `${pathPrefix}.filters.gpuRamGbMax`);
      if (!v.ok) return { ok: false, error: v.error };
      f.gpuRamGbMax = v.value;
    }
    if (fl.priceMax !== undefined) {
      const v = parseNonNegativeNumber(fl.priceMax, `${pathPrefix}.filters.priceMax`);
      if (!v.ok) return { ok: false, error: v.error };
      f.priceMax = v.value;
    }
    if (fl.maxAvgLatencyMs !== undefined) {
      const v = parseNonNegativeNumber(fl.maxAvgLatencyMs, `${pathPrefix}.filters.maxAvgLatencyMs`);
      if (!v.ok) return { ok: false, error: v.error };
      f.maxAvgLatencyMs = v.value;
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
    if (Object.keys(f).length > 0) out.filters = f;
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

  const af = app.filters;
  const uf = user.filters;
  if (af || uf) {
    const f: DiscoveryPolicyFilters = {};
    const gminA = af?.gpuRamGbMin;
    const gminU = uf?.gpuRamGbMin;
    if (gminA !== undefined || gminU !== undefined) {
      f.gpuRamGbMin = Math.max(gminA ?? 0, gminU ?? 0);
    }
    const gmaxA = af?.gpuRamGbMax;
    const gmaxU = uf?.gpuRamGbMax;
    if (gmaxA !== undefined && gmaxU !== undefined) f.gpuRamGbMax = Math.min(gmaxA, gmaxU);
    else if (gmaxU !== undefined) f.gpuRamGbMax = gmaxU;
    else if (gmaxA !== undefined) f.gpuRamGbMax = gmaxA;

    const pA = af?.priceMax;
    const pU = uf?.priceMax;
    if (pA !== undefined && pU !== undefined) f.priceMax = Math.min(pA, pU);
    else if (pU !== undefined) f.priceMax = pU;
    else if (pA !== undefined) f.priceMax = pA;

    const lA = af?.maxAvgLatencyMs;
    const lU = uf?.maxAvgLatencyMs;
    if (lA !== undefined && lU !== undefined) f.maxAvgLatencyMs = Math.min(lA, lU);
    else if (lU !== undefined) f.maxAvgLatencyMs = lU;
    else if (lA !== undefined) f.maxAvgLatencyMs = lA;

    const sA = af?.maxSwapRatio;
    const sU = uf?.maxSwapRatio;
    if (sA !== undefined && sU !== undefined) f.maxSwapRatio = Math.min(sA, sU);
    else if (sU !== undefined) f.maxSwapRatio = sU;
    else if (sA !== undefined) f.maxSwapRatio = sA;

    if (Object.keys(f).length > 0) out.filters = f;
    else delete out.filters;
  }

  return out;
}
