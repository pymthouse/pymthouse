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
import { desc, eq, gte } from "drizzle-orm";
import { v4 as uuidv4 } from "uuid";
import { fetchEthUsdFromPublicExchanges } from "./public-exchange-spot";

export interface EthUsdOracleResult {
  priceUsd: number;
  /** "binance" | "kraken" | "cache" | "stale_cache" | "env" | "default" */
  source: string;
  observedAt: string;
  isFallback: boolean;
}

const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes
const ETH_SYMBOL = "ETH";
const DEFAULT_PRICE = 3000;

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

/**
 * Return the best available ETH/USD price with its provenance.
 * Always returns a result; uses DEFAULT_PRICE as the last-resort fallback.
 */
export async function getEthUsdOracle(): Promise<EthUsdOracleResult> {
  // 1. Fresh DB cache
  try {
    const fresh = await getFreshCacheRow();
    if (fresh) return fresh;
  } catch {
    // DB unavailable — continue to live fetch
  }

  // 2. Live public exchange fetch
  try {
    const spot = await fetchEthUsdFromPublicExchanges();
    if (spot !== null) {
      const now = new Date().toISOString();
      persistPriceAsync(spot.priceUsd, spot.exchange, now);
      return {
        priceUsd: spot.priceUsd,
        source: spot.exchange,
        observedAt: now,
        isFallback: false,
      };
    }
  } catch {
    // Live fetch failed — continue to stale cache
  }

  // 3. Stale DB cache
  try {
    const stale = await getStaleCacheRow();
    if (stale) return stale;
  } catch {
    // DB unavailable — continue to env/default
  }

  // 4. Environment variable
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

  // 5. Hardcoded default
  return {
    priceUsd: DEFAULT_PRICE,
    source: "default",
    observedAt: new Date().toISOString(),
    isFallback: true,
  };
}
