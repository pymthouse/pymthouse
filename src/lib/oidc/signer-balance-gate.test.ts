import test from "node:test";
import assert from "node:assert/strict";
import type { UsageIdentity } from "@pymthouse/clearinghouse-identity-webhook/protocol";
import { createSpendableBalanceCache } from "@/lib/oidc/signer-balance-gate";

function identity(subject: string): UsageIdentity {
  return {
    issuer: "https://pymthouse.com/api/v1/oidc",
    client_id: "app_3b386c81a1db1169fd2c3986",
    usage_subject: subject,
    usage_subject_type: "external_user_id",
  };
}

test("spendable balance cache serves repeat lookups within the TTL", async () => {
  let calls = 0;
  let nowMs = 0;
  const cached = createSpendableBalanceCache({
    ttlSeconds: 20,
    getBalance: async () => {
      calls += 1;
      return "1000000";
    },
    now: () => nowMs,
  });

  assert.equal(await cached(identity("user-1")), "1000000");
  nowMs += 5_000;
  assert.equal(await cached(identity("user-1")), "1000000");
  assert.equal(calls, 1);

  nowMs += 20_000;
  assert.equal(await cached(identity("user-1")), "1000000");
  assert.equal(calls, 2);
});

test("spendable balance cache coalesces concurrent lookups per identity", async () => {
  let calls = 0;
  const cached = createSpendableBalanceCache({
    ttlSeconds: 20,
    getBalance: async (id) => {
      calls += 1;
      await new Promise((resolve) => setTimeout(resolve, 10));
      return id.usage_subject === "user-1" ? "111" : "222";
    },
  });

  const results = await Promise.all([
    cached(identity("user-1")),
    cached(identity("user-1")),
    cached(identity("user-2")),
  ]);

  assert.deepEqual(results, ["111", "111", "222"]);
  assert.equal(calls, 2);
});

test("spendable balance cache does not cache failures", async () => {
  let calls = 0;
  const cached = createSpendableBalanceCache({
    ttlSeconds: 20,
    getBalance: async () => {
      calls += 1;
      if (calls === 1) {
        throw new Error("openmeter unavailable");
      }
      return "42";
    },
  });

  await assert.rejects(cached(identity("user-1")), /openmeter unavailable/);
  assert.equal(await cached(identity("user-1")), "42");
  assert.equal(calls, 2);
});

test("spendable balance cache is disabled when ttl is zero", async () => {
  let calls = 0;
  const cached = createSpendableBalanceCache({
    ttlSeconds: 0,
    getBalance: async () => {
      calls += 1;
      return "7";
    },
  });

  assert.equal(await cached(identity("user-1")), "7");
  assert.equal(await cached(identity("user-1")), "7");
  assert.equal(calls, 2);
});

test("spendable balance cache stays bounded when every entry is inflight", async () => {
  const maxEntries = 3;
  let calls = 0;
  let blockLookups = true;
  const waiters: Array<() => void> = [];
  const cached = createSpendableBalanceCache({
    ttlSeconds: 60,
    maxEntries,
    getBalance: async (id) => {
      calls += 1;
      if (blockLookups) {
        await new Promise<void>((resolve) => {
          waiters.push(resolve);
        });
      }
      return id.usage_subject;
    },
  });

  const pending = [
    cached(identity("user-0")),
    cached(identity("user-1")),
    cached(identity("user-2")),
    cached(identity("user-3")),
  ];
  assert.equal(calls, 4);
  assert.equal(waiters.length, 4);

  for (const release of waiters) {
    release();
  }
  await Promise.all(pending);

  // Completions re-insert via setBounded; size stays at maxEntries, so the
  // oldest identity from the burst is no longer cached.
  blockLookups = false;
  const callsAfterBurst = calls;
  assert.equal(await cached(identity("user-1")), "user-1");
  assert.equal(await cached(identity("user-2")), "user-2");
  assert.equal(await cached(identity("user-3")), "user-3");
  assert.equal(calls, callsAfterBurst);
  assert.equal(await cached(identity("user-0")), "user-0");
  assert.equal(calls, callsAfterBurst + 1);
});

test("spendable balance cache repeats a lookup evicted while inflight", async () => {
  let calls = 0;
  const waiters: Array<() => void> = [];
  const cached = createSpendableBalanceCache({
    ttlSeconds: 60,
    maxEntries: 1,
    getBalance: async (id) => {
      calls += 1;
      await new Promise<void>((resolve) => {
        waiters.push(resolve);
      });
      return id.usage_subject;
    },
  });

  const first = cached(identity("user-1"));
  const second = cached(identity("user-2"));
  const repeatedFirst = cached(identity("user-1"));

  assert.equal(calls, 3);
  assert.equal(waiters.length, 3);

  for (const release of waiters) {
    release();
  }
  assert.deepEqual(await Promise.all([first, second, repeatedFirst]), [
    "user-1",
    "user-2",
    "user-1",
  ]);
});

test("spendable balance cache evicts oldest resolved entries at capacity", async () => {
  let calls = 0;
  const cached = createSpendableBalanceCache({
    ttlSeconds: 60,
    maxEntries: 2,
    getBalance: async (id) => {
      calls += 1;
      return id.usage_subject;
    },
  });

  assert.equal(await cached(identity("x")), "x");
  assert.equal(await cached(identity("y")), "y");
  assert.equal(await cached(identity("z")), "z"); // evicts x
  assert.equal(calls, 3);
  assert.equal(await cached(identity("y")), "y");
  assert.equal(await cached(identity("z")), "z");
  assert.equal(calls, 3);
  assert.equal(await cached(identity("x")), "x");
  assert.equal(calls, 4);
});
