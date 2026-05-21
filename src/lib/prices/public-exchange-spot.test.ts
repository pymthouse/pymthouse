import assert from "node:assert/strict";
import { test, mock } from "node:test";

// We need to mock global fetch before importing the module under test.
// Using node:test's mock.method to patch globalThis.fetch.

test("fetchEthUsdFromPublicExchanges: returns Binance result on success", async () => {
  const original = globalThis.fetch;
  let callCount = 0;
  globalThis.fetch = async (input: string | URL | Request) => {
    callCount++;
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url.includes("binance")) {
      return {
        ok: true,
        json: async () => ({ price: "2500.12" }),
      } as Response;
    }
    throw new Error("unexpected url");
  };

  try {
    const { fetchEthUsdFromPublicExchanges } = await import("./public-exchange-spot");
    const result = await fetchEthUsdFromPublicExchanges();
    assert.ok(result !== null);
    assert.equal(result!.exchange, "binance");
    assert.equal(result!.priceUsd, 2500.12);
    assert.equal(callCount, 1);
  } finally {
    globalThis.fetch = original;
  }
});

test("fetchEthUsdFromPublicExchanges: falls back to Kraken when Binance fails", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async (input: string | URL | Request) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url.includes("binance")) {
      return { ok: false, status: 503, json: async () => ({}) } as Response;
    }
    if (url.includes("kraken")) {
      return {
        ok: true,
        json: async () => ({
          result: { XETHZUSD: { c: ["1800.50", "1"] } },
        }),
      } as Response;
    }
    throw new Error("unexpected url");
  };

  try {
    const { fetchEthUsdFromPublicExchanges } = await import("./public-exchange-spot");
    const result = await fetchEthUsdFromPublicExchanges();
    assert.ok(result !== null);
    assert.equal(result!.exchange, "kraken");
    assert.equal(result!.priceUsd, 1800.5);
  } finally {
    globalThis.fetch = original;
  }
});

test("fetchEthUsdFromPublicExchanges: returns null when both fail", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => {
    return { ok: false, status: 503, json: async () => ({}) } as Response;
  };

  try {
    const { fetchEthUsdFromPublicExchanges } = await import("./public-exchange-spot");
    const result = await fetchEthUsdFromPublicExchanges();
    assert.equal(result, null);
  } finally {
    globalThis.fetch = original;
  }
});

test("fetchEthUsdFromPublicExchanges: returns null when Binance returns non-positive price", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async (input: string | URL | Request) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url.includes("binance")) {
      return { ok: true, json: async () => ({ price: "0" }) } as Response;
    }
    return { ok: false, status: 503, json: async () => ({}) } as Response;
  };

  try {
    const { fetchEthUsdFromPublicExchanges } = await import("./public-exchange-spot");
    const result = await fetchEthUsdFromPublicExchanges();
    // Binance returns 0 (invalid), should fall back to Kraken which also fails → null
    assert.equal(result, null);
  } finally {
    globalThis.fetch = original;
  }
});

test("fetchEthUsdFromPublicExchanges: returns null when Binance returns invalid JSON", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async (input: string | URL | Request) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url.includes("binance")) {
      return { ok: true, json: async () => { throw new SyntaxError("bad json"); } } as unknown as Response;
    }
    return { ok: false, status: 503, json: async () => ({}) } as Response;
  };

  try {
    const { fetchEthUsdFromPublicExchanges } = await import("./public-exchange-spot");
    const result = await fetchEthUsdFromPublicExchanges();
    assert.equal(result, null);
  } finally {
    globalThis.fetch = original;
  }
});
