import assert from "node:assert/strict";
import test from "node:test";
import type { UsageIdentity } from "@pymthouse/clearinghouse-identity-webhook/protocol";
import { WebhookError } from "@pymthouse/clearinghouse-identity-webhook/protocol";

import {
  __resetSignerBalanceCachesForTests,
  buildSignerBalanceCheck,
  seedSignerOverageEligibility,
  seedSignerSpendableBalance,
} from "@/lib/oidc/signer-balance-gate";
import { __setTryAutoTopUpIfEnabledForTests } from "@/lib/stripe/auto-topup";

function identity(subject: string): UsageIdentity {
  return {
    issuer: "https://pymthouse.com/api/v1/oidc",
    client_id: "app_test_overage",
    usage_subject: subject,
    usage_subject_type: "external_user_id",
  };
}

function withOpenMeterConfigured(t: test.TestContext) {
  const prevUrl = process.env.OPENMETER_URL;
  const prevKey = process.env.OPENMETER_API_KEY;
  const prevLive = process.env.OPENMETER_TEST_LIVE;
  t.after(() => {
    if (prevUrl === undefined) delete process.env.OPENMETER_URL;
    else process.env.OPENMETER_URL = prevUrl;
    if (prevKey === undefined) delete process.env.OPENMETER_API_KEY;
    else process.env.OPENMETER_API_KEY = prevKey;
    if (prevLive === undefined) delete process.env.OPENMETER_TEST_LIVE;
    else process.env.OPENMETER_TEST_LIVE = prevLive;
    __resetSignerBalanceCachesForTests();
    __setTryAutoTopUpIfEnabledForTests(null);
  });

  process.env.OPENMETER_URL = "https://us.api.konghq.com/v3/openmeter";
  process.env.OPENMETER_API_KEY = "om_test_key";
  process.env.OPENMETER_TEST_LIVE = "1";
  __resetSignerBalanceCachesForTests();
  __setTryAutoTopUpIfEnabledForTests(async () => ({
    status: "skipped",
    reason: "test",
  }));
}

test("buildSignerBalanceCheck is undefined when OpenMeter is not configured", (t) => {
  const prevUrl = process.env.OPENMETER_URL;
  const prevKey = process.env.OPENMETER_API_KEY;
  const prevLive = process.env.OPENMETER_TEST_LIVE;
  t.after(() => {
    if (prevUrl === undefined) delete process.env.OPENMETER_URL;
    else process.env.OPENMETER_URL = prevUrl;
    if (prevKey === undefined) delete process.env.OPENMETER_API_KEY;
    else process.env.OPENMETER_API_KEY = prevKey;
    if (prevLive === undefined) delete process.env.OPENMETER_TEST_LIVE;
    else process.env.OPENMETER_TEST_LIVE = prevLive;
    __resetSignerBalanceCachesForTests();
  });
  delete process.env.OPENMETER_URL;
  delete process.env.OPENMETER_API_KEY;
  delete process.env.OPENMETER_TEST_LIVE;
  __resetSignerBalanceCachesForTests();
  assert.equal(buildSignerBalanceCheck(), undefined);
});

test("buildSignerBalanceCheck rejects zero spendable without overage", async (t) => {
  withOpenMeterConfigured(t);

  seedSignerSpendableBalance("app_test_overage", "eu_zero", "0");
  seedSignerOverageEligibility("app_test_overage", "eu_zero", false);

  const check = buildSignerBalanceCheck();
  assert.ok(check);

  await assert.rejects(
    async () => {
      await check({
        identity: identity("eu_zero"),
        expiry: Math.floor(Date.now() / 1000) + 60,
        payload: {},
        request: new Request("http://localhost/authorize"),
      });
    },
    (err: unknown) =>
      err instanceof WebhookError &&
      err.status === 483 &&
      // Chargeable lookup is env-dependent for this fixture app: false →
      // no_payment_method; null/true with overage closed → overage_not_available.
      (err.message === "Payment method required" ||
        err.message === "Add funds to continue"),
  );
});

test("buildSignerBalanceCheck allows zero spendable when overage eligible", async (t) => {
  withOpenMeterConfigured(t);

  seedSignerSpendableBalance("app_test_overage", "eu_overage", "0");
  seedSignerOverageEligibility("app_test_overage", "eu_overage", true);

  const check = buildSignerBalanceCheck();
  assert.ok(check);

  const result = await check({
    identity: identity("eu_overage"),
    expiry: Math.floor(Date.now() / 1000) + 60,
    payload: {},
    request: new Request("http://localhost/authorize"),
  });
  assert.ok(result && typeof result === "object" && "expiry" in result);
  assert.ok(
    (result as { expiry: number }).expiry > Math.floor(Date.now() / 1000),
  );
});

test("buildSignerBalanceCheck allows positive spendable without overage", async (t) => {
  withOpenMeterConfigured(t);

  seedSignerSpendableBalance("app_test_overage", "eu_funded", "5000000");
  seedSignerOverageEligibility("app_test_overage", "eu_funded", false);

  const check = buildSignerBalanceCheck();
  assert.ok(check);
  const result = await check({
    identity: identity("eu_funded"),
    expiry: Math.floor(Date.now() / 1000) + 60,
    payload: {},
    request: new Request("http://localhost/authorize"),
  });
  assert.ok(result && typeof result === "object" && "expiry" in result);
});

test("buildSignerBalanceCheck rejects non-integer balance", async (t) => {
  withOpenMeterConfigured(t);

  seedSignerSpendableBalance("app_test_overage", "eu_bad", "not-micros");

  const check = buildSignerBalanceCheck();
  assert.ok(check);
  await assert.rejects(
    async () => {
      await check({
        identity: identity("eu_bad"),
        expiry: Math.floor(Date.now() / 1000) + 60,
        payload: {},
        request: new Request("http://localhost/authorize"),
      });
    },
    (err: unknown) => err instanceof WebhookError && err.status === 503,
  );
});

test("buildSignerBalanceCheck denies when auto-top-up throws", async (t) => {
  withOpenMeterConfigured(t);
  t.after(() => __setTryAutoTopUpIfEnabledForTests(null));
  __setTryAutoTopUpIfEnabledForTests(async () => {
    throw new Error("stripe down");
  });

  seedSignerSpendableBalance("app_test_overage", "eu_topup_err", "0");
  seedSignerOverageEligibility("app_test_overage", "eu_topup_err", false);

  const check = buildSignerBalanceCheck();
  assert.ok(check);
  await assert.rejects(
    async () => {
      await check({
        identity: identity("eu_topup_err"),
        expiry: Math.floor(Date.now() / 1000) + 60,
        payload: {},
        request: new Request("http://localhost/authorize"),
      });
    },
    (err: unknown) => err instanceof WebhookError && err.status === 483,
  );
});

test("buildSignerBalanceCheck allows zero spendable after auto-top-up charge", async (t) => {
  withOpenMeterConfigured(t);
  t.after(() => __setTryAutoTopUpIfEnabledForTests(null));
  __setTryAutoTopUpIfEnabledForTests(async () => ({
    status: "charged",
    paymentIntentId: "pi_reload",
    grantedUsdMicros: "10000000",
  }));

  seedSignerSpendableBalance("app_test_overage", "eu_reload", "0");
  seedSignerOverageEligibility("app_test_overage", "eu_reload", false);

  const check = buildSignerBalanceCheck();
  assert.ok(check);
  const result = await check({
    identity: identity("eu_reload"),
    expiry: Math.floor(Date.now() / 1000) + 60,
    payload: {},
    request: new Request("http://localhost/authorize"),
  });
  assert.ok(result && typeof result === "object" && "expiry" in result);
});

test("__resetSignerBalanceCachesForTests is test-only", () => {
  assert.doesNotThrow(() => __resetSignerBalanceCachesForTests());
});
