import test from "node:test";
import assert from "node:assert/strict";
import { createAsyncTtlCache, resolveCacheTtlSeconds } from "@/lib/async-ttl-cache";

test("async ttl cache serves repeat lookups within the TTL", async () => {
  let calls = 0;
  let nowMs = 0;
  const cache = createAsyncTtlCache<string>({ ttlSeconds: 20, now: () => nowMs });
  const load = async () => {
    calls += 1;
    return "value";
  };

  assert.equal(await cache.get("k", load), "value");
  nowMs += 5_000;
  assert.equal(await cache.get("k", load), "value");
  assert.equal(calls, 1);

  nowMs += 20_000;
  assert.equal(await cache.get("k", load), "value");
  assert.equal(calls, 2);
});

test("async ttl cache coalesces concurrent loads per key", async () => {
  let calls = 0;
  const cache = createAsyncTtlCache<string>({ ttlSeconds: 20 });
  const load = (value: string) => async () => {
    calls += 1;
    await new Promise((resolve) => setTimeout(resolve, 10));
    return value;
  };

  const results = await Promise.all([
    cache.get("a", load("one")),
    cache.get("a", load("one")),
    cache.get("b", load("two")),
  ]);

  assert.deepEqual(results, ["one", "one", "two"]);
  assert.equal(calls, 2);
});

test("async ttl cache does not cache failures", async () => {
  let calls = 0;
  const cache = createAsyncTtlCache<string>({ ttlSeconds: 20 });
  const load = async () => {
    calls += 1;
    if (calls === 1) {
      throw new Error("upstream unavailable");
    }
    return "ok";
  };

  await assert.rejects(cache.get("k", load), /upstream unavailable/);
  assert.equal(await cache.get("k", load), "ok");
  assert.equal(calls, 2);
});

test("async ttl cache is a passthrough when ttl is zero", async () => {
  let calls = 0;
  const cache = createAsyncTtlCache<string>({ ttlSeconds: 0 });
  const load = async () => {
    calls += 1;
    return "v";
  };

  cache.seed("k", "seeded");
  assert.equal(await cache.get("k", load), "v");
  assert.equal(await cache.get("k", load), "v");
  assert.equal(calls, 2);
});

test("async ttl cache seed serves without loading and delete forces a reload", async () => {
  let calls = 0;
  const cache = createAsyncTtlCache<string>({ ttlSeconds: 60 });
  const load = async () => {
    calls += 1;
    return "loaded";
  };

  cache.seed("k", "seeded");
  assert.equal(await cache.get("k", load), "seeded");
  assert.equal(calls, 0);

  cache.delete("k");
  assert.equal(await cache.get("k", load), "loaded");
  assert.equal(calls, 1);
});

test("async ttl cache evicts oldest entries at capacity", async () => {
  let calls = 0;
  const cache = createAsyncTtlCache<string>({ ttlSeconds: 60, maxEntries: 2 });
  const load = (value: string) => async () => {
    calls += 1;
    return value;
  };

  assert.equal(await cache.get("x", load("x")), "x");
  assert.equal(await cache.get("y", load("y")), "y");
  assert.equal(await cache.get("z", load("z")), "z"); // evicts x
  assert.equal(calls, 3);
  assert.equal(await cache.get("y", load("y")), "y");
  assert.equal(await cache.get("z", load("z")), "z");
  assert.equal(calls, 3);
  assert.equal(await cache.get("x", load("x")), "x");
  assert.equal(calls, 4);
});

test("resolveCacheTtlSeconds prefers a valid env value", () => {
  process.env.ASYNC_TTL_CACHE_TEST_TTL = "42";
  try {
    assert.equal(resolveCacheTtlSeconds("ASYNC_TTL_CACHE_TEST_TTL", 300), 42);
  } finally {
    delete process.env.ASYNC_TTL_CACHE_TEST_TTL;
  }
});

test("resolveCacheTtlSeconds allows disabling via env zero", () => {
  process.env.ASYNC_TTL_CACHE_TEST_TTL = "0";
  try {
    assert.equal(resolveCacheTtlSeconds("ASYNC_TTL_CACHE_TEST_TTL", 300), 0);
  } finally {
    delete process.env.ASYNC_TTL_CACHE_TEST_TTL;
  }
});

test("resolveCacheTtlSeconds defaults to disabled under NODE_ENV=test", () => {
  // src/test-env.ts sets NODE_ENV=test for this suite.
  assert.equal(resolveCacheTtlSeconds("ASYNC_TTL_CACHE_TEST_UNSET", 300), 0);
});

test("resolveCacheTtlSeconds ignores invalid env values", () => {
  process.env.ASYNC_TTL_CACHE_TEST_TTL = "not-a-number";
  try {
    assert.equal(resolveCacheTtlSeconds("ASYNC_TTL_CACHE_TEST_TTL", 300), 0);
  } finally {
    delete process.env.ASYNC_TTL_CACHE_TEST_TTL;
  }
});
