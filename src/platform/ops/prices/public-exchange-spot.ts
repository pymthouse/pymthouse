/**
 * Fetch the ETH/USD spot price from public exchanges.
 *
 * Implements the same resolution pattern as livepeer/naap PR #283:
 *  1. Binance public ticker (ETHUSDT — treated as USD for spot estimates)
 *  2. Kraken public ticker (XETHZUSD)
 *
 * Never throws. Returns null when both sources are unavailable or return
 * invalid data. Callers are responsible for fallback (stale cache / env / default).
 */

export interface SpotResult {
  priceUsd: number;
  /** "binance" | "kraken" */
  exchange: string;
}

const TIMEOUT_MS = 3000;

async function fetchWithTimeout(url: string): Promise<Response> {
  return fetch(url, {
    headers: { Accept: "application/json" },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
}

/** Parse and validate a price number: must be finite and positive. */
function parsePositiveNumber(v: unknown): number | null {
  const n = typeof v === "string" ? parseFloat(v) : typeof v === "number" ? v : NaN;
  return Number.isFinite(n) && n > 0 ? n : null;
}

async function fetchBinance(): Promise<SpotResult | null> {
  try {
    const res = await fetchWithTimeout(
      "https://api.binance.com/api/v3/ticker/price?symbol=ETHUSDT",
    );
    if (!res.ok) return null;
    const data = (await res.json()) as unknown;
    if (typeof data !== "object" || data === null) return null;
    const price = parsePositiveNumber((data as Record<string, unknown>).price);
    return price !== null ? { priceUsd: price, exchange: "binance" } : null;
  } catch {
    return null;
  }
}

async function fetchKraken(): Promise<SpotResult | null> {
  try {
    const res = await fetchWithTimeout(
      "https://api.kraken.com/0/public/Ticker?pair=XETHZUSD",
    );
    if (!res.ok) return null;
    const data = (await res.json()) as unknown;
    if (typeof data !== "object" || data === null) return null;
    const result = (data as Record<string, unknown>).result;
    if (typeof result !== "object" || result === null) return null;
    // Kraken returns the pair data under a key like "XETHZUSD" or "ETHUSD"
    const pairs = Object.values(result as Record<string, unknown>);
    if (pairs.length === 0) return null;
    const pair = pairs[0] as Record<string, unknown> | null;
    if (!pair) return null;
    // "c" is the last trade closed: [price, lot volume]
    const c = pair.c;
    if (!Array.isArray(c) || c.length === 0) return null;
    const price = parsePositiveNumber(c[0]);
    return price !== null ? { priceUsd: price, exchange: "kraken" } : null;
  } catch {
    return null;
  }
}

/**
 * Try Binance first, then Kraken. Returns the first successful result or null.
 */
export async function fetchEthUsdFromPublicExchanges(): Promise<SpotResult | null> {
  const binance = await fetchBinance();
  if (binance !== null) return binance;
  return fetchKraken();
}
