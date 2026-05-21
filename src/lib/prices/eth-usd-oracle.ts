/**
 * ETH/USD oracle with DB-backed caching.
 *
 * Resolution order (matching livepeer/naap PR #283):
 *  1. Fresh price_oracle_snapshots ETH row within CACHE_TTL_MS.
 *  2. Live public exchange fetch (Binance → Kraken).
 *  3. Persist valid live value asynchronously.
 *  4. Most recent stale ETH cache row.
 *  5. process.env.ETH_USD_PRICE if a positive number.
 *  6. Default 3000.
 *
 * Never persists 0 or invalid prices. Keeps raw pricing cache separate from
 * ETH/USD-decorated values so a long pricing TTL does not stale the USD conversion.
 */

import { db } from "@/db/index";
import { priceOracleSnapshots } from "@/db/schema";
import { desc, eq } from "drizzle-orm";
import { v4 as uuidv4 } from "uuid";
import { fetchEthUsdFromPublicExchanges } from "./public-exchange-spot";
import { resolveBillingOracleProviderKey } from "./fiat-oracle-registry";

export interface EthUsdOracleResult {
  priceUsd: number;
  /** "binance" | "kraken" | "cache" | "stale_cache" | "env" | "default" */
  source: string;
  observedAt: string;
  isFallback: boolean;
}

export interface EthUsdOracleOptions {
  appId?: string | null;
  providerKey?: string | null;
}

const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes
const ETH_SYMBOL = "ETH";
const DEFAULT_PRICE = 3000;
const MEMORY_TTL_MS = 45 * 1000;

const memoryOracleCache = new Map<string, EthUsdOracleResult>();
const refreshInFlight = new Set<string>();

export function resetEthUsdOracleCacheForTests(): void {
  memoryOracleCache.clear();
  refreshInFlight.clear();
}

function cacheKeyForProvider(providerKey: string): string {
  return `${providerKey}:${ETH_SYMBOL}`;
}

function isMemoryFresh(entry: EthUsdOracleResult): boolean {
  return Date.now() - Date.parse(entry.observedAt) <= MEMORY_TTL_MS;
}

async function getFreshCacheRow(): Promise<EthUsdOracleResult | null> {
  const cutoff = new Date(Date.now() - CACHE_TTL_MS).toISOString();
  const rows = await db
    .select()
    .from(priceOracleSnapshots)
    .where(
      eq(priceOracleSnapshots.symbol, ETH_SYMBOL),
    )
    .orderBy(desc(priceOracleSnapshots.fetchedAt))
    .limit(1);

  if (rows.length === 0) return null;
  const row = rows[0];
  if (row.fetchedAt < cutoff) return null; // stale
  const price = parseFloat(row.priceUsd);
  if (!Number.isFinite(price) || price <= 0) return null;
  return {
    priceUsd: price,
    source: "cache",
    observedAt: row.fetchedAt,
    isFallback: false,
  };
}

async function getStaleCacheRow(): Promise<EthUsdOracleResult | null> {
  const rows = await db
    .select()
    .from(priceOracleSnapshots)
    .where(eq(priceOracleSnapshots.symbol, ETH_SYMBOL))
    .orderBy(desc(priceOracleSnapshots.fetchedAt))
    .limit(1);

  if (rows.length === 0) return null;
  const row = rows[0];
  const price = parseFloat(row.priceUsd);
  if (!Number.isFinite(price) || price <= 0) return null;
  return {
    priceUsd: price,
    source: "stale_cache",
    observedAt: row.fetchedAt,
    isFallback: true,
  };
}

function persistPriceAsync(priceUsd: number, exchange: string, fetchedAt: string): void {
  if (!Number.isFinite(priceUsd) || priceUsd <= 0) return;
  const source = exchange === "binance" || exchange === "kraken" ? exchange : "public_exchange";
  db.insert(priceOracleSnapshots)
    .values({
      id: uuidv4(),
      symbol: ETH_SYMBOL,
      priceUsd: priceUsd.toString(),
      source,
      fetchedAt,
      createdAt: new Date().toISOString(),
    })
    .catch(() => {
      // Background persistence — do not surface errors to the billing hot path.
    });
}

async function refreshLiveSpotAsync(providerKey: string): Promise<void> {
  const cacheKey = cacheKeyForProvider(providerKey);
  if (refreshInFlight.has(cacheKey)) return;
  refreshInFlight.add(cacheKey);
  try {
    const spot = await fetchEthUsdFromPublicExchanges();
    if (spot === null) return;
    const observedAt = new Date().toISOString();
    persistPriceAsync(spot.priceUsd, spot.exchange, observedAt);
    memoryOracleCache.set(cacheKey, {
      priceUsd: spot.priceUsd,
      source: spot.exchange,
      observedAt,
      isFallback: false,
    });
  } catch {
    // Never bubble refresh failures into the signing path.
  } finally {
    refreshInFlight.delete(cacheKey);
  }
}

function envOrDefaultResult(): EthUsdOracleResult {
  const envPrice = process.env.ETH_USD_PRICE
    ? parseFloat(process.env.ETH_USD_PRICE)
    : NaN;
  if (Number.isFinite(envPrice) && envPrice > 0) {
    return {
      priceUsd: envPrice,
      source: "env",
      observedAt: new Date().toISOString(),
      isFallback: true,
    };
  }

  return {
    priceUsd: DEFAULT_PRICE,
    source: "default",
    observedAt: new Date().toISOString(),
    isFallback: true,
  };
}

/**
 * Return the best available ETH/USD price with its provenance.
 * Always returns a result; uses DEFAULT_PRICE as the last-resort fallback.
 */
export async function getEthUsdOracle(
  options: EthUsdOracleOptions = {},
): Promise<EthUsdOracleResult> {
  const provider = resolveBillingOracleProviderKey(options.providerKey);
  const cacheKey = cacheKeyForProvider(provider.key);
  const memoryEntry = memoryOracleCache.get(cacheKey);
  if (memoryEntry && isMemoryFresh(memoryEntry)) {
    return memoryEntry;
  }

  // 1. Fresh DB cache
  try {
    const fresh = await getFreshCacheRow();
    if (fresh) {
      memoryOracleCache.set(cacheKey, fresh);
      return fresh;
    }
  } catch {
    // DB unavailable — continue to fallback chain
  }

  // 2. Stale DB cache (serve immediately, then refresh in background)
  try {
    const stale = await getStaleCacheRow();
    if (stale) {
      memoryOracleCache.set(cacheKey, stale);
      void refreshLiveSpotAsync(provider.key);
      return stale;
    }
  } catch {
    // DB unavailable — continue to env/default
  }

  // 3. Memory fallback (stale but better than env/default) and async refresh.
  if (memoryEntry) {
    void refreshLiveSpotAsync(provider.key);
    return {
      ...memoryEntry,
      isFallback: true,
      source:
        memoryEntry.source === "cache" || memoryEntry.source === "stale_cache"
          ? "stale_cache"
          : memoryEntry.source,
    };
  }

  // 4. Environment/default fallback (always return immediately), refresh in background.
  const fallback = envOrDefaultResult();
  memoryOracleCache.set(cacheKey, fallback);
  void refreshLiveSpotAsync(provider.key);
  return fallback;
}
