import test from "node:test";
import assert from "node:assert/strict";
import type { UsageIdentity } from "@pymthouse/clearinghouse-identity-webhook/protocol";
import {
  createSpendableBalanceCache,
  seedSignerSpendableBalance,
} from "@/lib/oidc/signer-balance-gate";

function identity(subject: string): UsageIdentity {
  return {
    issuer: "https://pymthouse.com/api/v1/oidc",
    client_id: "app_3b386c81a1db1169fd2c3986",
    usage_subject: subject,
    usage_subject_type: "external_user_id",
  };
}

test("spendable balance cache seed serves without calling getBalance", async () => {
  let calls = 0;
  const cached = createSpendableBalanceCache({
    ttlSeconds: 20,
    getBalance: async () => {
      calls += 1;
      return "should-not-run";
    },
  });

  cached.seed("app_3b386c81a1db1169fd2c3986", "user-1", "999");
  assert.equal(await cached.get(identity("user-1")), "999");
  assert.equal(calls, 0);
});

test("seed under payer key is served when webhook looks up payer#actor", async () => {
  let lookedUp: string | null = null;
  const cached = createSpendableBalanceCache({
    ttlSeconds: 20,
    getBalance: async (id) => {
      lookedUp = id.usage_subject;
      return "should-not-run";
    },
  });

  cached.seed("app_3b386c81a1db1169fd2c3986", "eu_payer", "500000");
  assert.equal(
    await cached.get(identity("eu_payer#eu_43eac8e3fe4dd854633da7a23fb21114")),
    "500000",
  );
  assert.equal(lookedUp, null);
});

test("payer#actor cache miss looks up the actor external id", async () => {
  let lookedUp: string | null = null;
  const cached = createSpendableBalanceCache({
    ttlSeconds: 20,
    getBalance: async (id) => {
      lookedUp = id.usage_subject;
      return "120000";
    },
  });

  assert.equal(
    await cached.get(identity("eu_payer#eu_43eac8e3fe4dd854633da7a23fb21114")),
    "120000",
  );
  assert.equal(lookedUp, "eu_43eac8e3fe4dd854633da7a23fb21114");
});

test("seedSignerSpendableBalance does not throw", () => {
  assert.doesNotThrow(() =>
    seedSignerSpendableBalance("app_x", "user-y", "1"),
  );
});
