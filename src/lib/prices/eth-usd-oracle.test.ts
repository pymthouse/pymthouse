import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import { db } from "@/db/index";
import { priceOracleSnapshots } from "@/db/schema";
import { eq } from "drizzle-orm";
import { test } from "@/test-utils/db-guard";

import { getEthUsdOracle, resetEthUsdOracleCacheForTests } from "./eth-usd-oracle";

test("getEthUsdOracle returns fresh cached snapshot when present", async () => {
  const providerKey = "global_eth_usd";
  resetEthUsdOracleCacheForTests();
  await db.delete(priceOracleSnapshots).where(eq(priceOracleSnapshots.symbol, "ETH"));
  await db.insert(priceOracleSnapshots).values({
    id: randomUUID(),
    symbol: "ETH",
    priceUsd: "3210.12",
    source: "cache",
    fetchedAt: new Date().toISOString(),
    createdAt: new Date().toISOString(),
  });

  const result = await getEthUsdOracle({ providerKey });
  assert.equal(result.source, "cache");
  assert.equal(result.isFallback, false);
  assert.equal(result.priceUsd, 3210.12);
});

test("getEthUsdOracle serves stale cache without waiting for live refresh", async () => {
  const providerKey = "global_eth_usd";
  resetEthUsdOracleCacheForTests();
  await db.delete(priceOracleSnapshots).where(eq(priceOracleSnapshots.symbol, "ETH"));
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    await new Promise((resolve) => setTimeout(resolve, 250));
    return { ok: false, status: 503, json: async () => ({}) } as Response;
  };

  const staleFetchedAt = new Date(Date.now() - 10 * 60 * 1000).toISOString();
  await db.insert(priceOracleSnapshots).values({
    id: randomUUID(),
    symbol: "ETH",
    priceUsd: "2999.99",
    source: "cache",
    fetchedAt: staleFetchedAt,
    createdAt: new Date().toISOString(),
  });

  const startedAt = Date.now();
  try {
    const result = await getEthUsdOracle({ providerKey });
    const elapsedMs = Date.now() - startedAt;
    assert.ok(elapsedMs < 200, `expected quick stale-cache read, got ${elapsedMs}ms`);
    assert.equal(result.source, "stale_cache");
    assert.equal(result.isFallback, true);
    assert.equal(result.priceUsd, 2999.99);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("getEthUsdOracle falls back to ETH_USD_PRICE when cache is empty", async () => {
  const providerKey = "global_eth_usd";
  resetEthUsdOracleCacheForTests();
  const previous = process.env.ETH_USD_PRICE;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    return { ok: false, status: 503, json: async () => ({}) } as Response;
  };
  process.env.ETH_USD_PRICE = "2800.5";
  await db.delete(priceOracleSnapshots).where(eq(priceOracleSnapshots.symbol, "ETH"));
  try {
    const result = await getEthUsdOracle({ providerKey });
    assert.equal(result.source, "env");
    assert.equal(result.isFallback, true);
    assert.equal(result.priceUsd, 2800.5);
  } finally {
    process.env.ETH_USD_PRICE = previous;
    globalThis.fetch = originalFetch;
  }
});
