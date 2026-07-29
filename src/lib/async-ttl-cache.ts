/**
 * Bounded in-process TTL cache with singleflight, extracted from the
 * remote-signer spendable-balance cache (issue #248) so other hot-path
 * lookups (billing identity, OpenMeter customer/plan ensures) share the
 * same semantics: concurrent callers for one key share a single load,
 * repeat calls within the TTL are served from memory, and failed loads are
 * never cached so transient errors retry.
 */

const DEFAULT_MAX_ENTRIES = 1000;

type CacheEntry<V> = {
  expiresAtMs: number;
  value?: V;
  inflight?: Promise<V>;
};

export type AsyncTtlCache<V> = {
  /** Return the cached value for `key`, loading (singleflight) on miss. */
  get: (key: string, load: () => Promise<V>) => Promise<V>;
  /** Insert a known-fresh value (e.g. produced by a write in the same request). */
  seed: (key: string, value: V) => void;
  /** Drop one key so the next get reloads. */
  delete: (key: string) => void;
};

/**
 * Resolve a cache TTL from an env var with a hardcoded default. Module-level
 * caches default to disabled (0) under NODE_ENV=test so unit tests stay
 * hermetic; an explicit env value always wins, including in tests.
 */
export function resolveCacheTtlSeconds(name: string, fallbackSeconds: number): number {
  const raw = process.env[name]?.trim();
  if (raw) {
    const parsed = Number(raw);
    if (Number.isFinite(parsed) && parsed >= 0) {
      return parsed;
    }
  }
  if (process.env.NODE_ENV === "test") {
    return 0;
  }
  return fallbackSeconds;
}

export function createAsyncTtlCache<V>(options: {
  ttlSeconds: number;
  /** Bound on retained entries; oldest inserted are evicted first. */
  maxEntries?: number;
  /** Override for tests; production uses Date.now. */
  now?: () => number;
}): AsyncTtlCache<V> {
  const { ttlSeconds } = options;
  const now = options.now ?? Date.now;
  const maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;

  if (ttlSeconds <= 0) {
    return {
      get: (_key, load) => load(),
      seed: () => undefined,
      delete: () => undefined,
    };
  }

  const entries = new Map<string, CacheEntry<V>>();

  /** Insert/update while keeping `entries.size <= maxEntries` (evicts oldest first). */
  function setBounded(key: string, entry: CacheEntry<V>): void {
    if (entries.has(key)) {
      entries.delete(key);
    }
    while (entries.size >= maxEntries) {
      const oldestKey = entries.keys().next().value;
      if (oldestKey === undefined) {
        break;
      }
      entries.delete(oldestKey);
    }
    entries.set(key, entry);
  }

  return {
    seed(key, value) {
      setBounded(key, { expiresAtMs: now() + ttlSeconds * 1000, value });
    },
    delete(key) {
      entries.delete(key);
    },
    get(key, load) {
      const existing = entries.get(key);
      if (existing) {
        if (existing.inflight) {
          return existing.inflight;
        }
        if (existing.expiresAtMs > now()) {
          return Promise.resolve(existing.value as V);
        }
        entries.delete(key);
      }

      const inflight = load().then(
        (value) => {
          setBounded(key, { expiresAtMs: now() + ttlSeconds * 1000, value });
          return value;
        },
        (err) => {
          entries.delete(key);
          throw err;
        },
      );

      setBounded(key, { expiresAtMs: now() + ttlSeconds * 1000, inflight });
      return inflight;
    },
  };
}
