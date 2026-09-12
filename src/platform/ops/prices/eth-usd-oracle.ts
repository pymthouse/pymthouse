import { v4 as uuidv4 } from "uuid";
import { desc, eq } from "drizzle-orm";
import { db } from "@/db/index";
import { priceOracleSnapshots } from "@/db/schema";
import { fetchEthUsdFromPublicExchanges } from "./public-exchange-spot";

export interface EthUsdOracleResult {
  priceUsd: number;
  source: string;
  observedAt: string;
  isFallback: boolean;
}

const CACHE_TTL_MS = 5 * 60 * 1000;
const ETH_SYMBOL = "ETH";
const DEFAULT_PRICE = 3000;

async function getFreshCacheRow(): Promise<EthUsdOracleResult | null> {
  const cutoff = new Date(Date.now() - CACHE_TTL_MS).toISOString();
  const rows = await db
    .select()
    .from(priceOracleSnapshots)
    .where(eq(priceOracleSnapshots.symbol, ETH_SYMBOL))
    .orderBy(desc(priceOracleSnapshots.fetchedAt))
    .limit(1);

  if (rows.length === 0) return null;
  const row = rows[0];
  if (row.fetchedAt < cutoff) return null;
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

export async function getEthUsdOracle(): Promise<EthUsdOracleResult> {
  try {
    const fresh = await getFreshCacheRow();
    if (fresh) return fresh;
  } catch {
    // DB unavailable — continue to live fetch
  }

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

  try {
    const stale = await getStaleCacheRow();
    if (stale) return stale;
  } catch {
    // DB unavailable — continue to env/default
  }

  const envPrice = process.env.ETH_USD_PRICE ? parseFloat(process.env.ETH_USD_PRICE) : NaN;
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
