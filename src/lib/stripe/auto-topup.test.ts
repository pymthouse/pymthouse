import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_AUTO_TOP_UP_USD_MICROS,
  parseAutoTopUpPatch,
  serializeAutoTopUpPrefs,
  tryAutoTopUpIfEnabled,
  __setAutoTopUpRuntimeForTests,
  __setTryAutoTopUpIfEnabledForTests,
  type AutoTopUpRuntime,
} from "@/lib/stripe/auto-topup";
import { LEGACY_AUTO_TOP_UP_METADATA_FLAG } from "@/lib/stripe/legacy-auto-topup";

const GRANT_RESULT = {
  externalUserId: "eu_y",
  source: "topup" as const,
  grantedUsdMicros: "10000000",
  featureKey: "credits",
  balance: null,
};

function uniqueIds(label: string): {
  publicClientId: string;
  externalUserId: string;
} {
  const suffix = `${label}_${Date.now()}_${Math.random().toString(16).slice(2)}`;
  return {
    publicClientId: `app_${suffix}`,
    externalUserId: `eu_${suffix}`,
  };
}

function merchantRuntime(
  overrides: Partial<AutoTopUpRuntime> = {},
): AutoTopUpRuntime {
  return {
    getProviderApp: async () => ({ id: "dev_app_1" }),
    loadPrefs: async () => ({ enabled: true, amountUsd: "10.00" }),
    getAppBillingConfig: async () => ({
      billingMode: "merchant",
      stripeConnectedAccountId: "acct_1",
      defaultCurrency: "USD",
      applicationFeeBps: 250,
    }),
    listAppUserPaymentMethods: async () => [
      { id: "pm_1", isDefault: true },
    ],
    getAppUserStripeCustomer: async () => ({
      stripeCustomerId: "cus_1",
      stripeConnectedAccountId: "acct_1",
    }),
    createConnectedOffSessionPaymentIntent: async () => ({
      id: "pi_ok",
      status: "succeeded",
    }),
    grantAllowanceUsdMicros: async () => GRANT_RESULT,
    ...overrides,
  };
}

function withRuntime(
  t: test.TestContext,
  overrides: Partial<AutoTopUpRuntime> = {},
): void {
  t.after(() => {
    __setAutoTopUpRuntimeForTests(null);
    __setTryAutoTopUpIfEnabledForTests(null);
  });
  __setTryAutoTopUpIfEnabledForTests(null);
  __setAutoTopUpRuntimeForTests(merchantRuntime(overrides));
}

test("parseAutoTopUpPatch requires a boolean enabled flag", () => {
  assert.deepEqual(parseAutoTopUpPatch({}), {
    ok: false,
    error: "enabled must be a boolean",
  });
  assert.deepEqual(parseAutoTopUpPatch({ enabled: "true" }), {
    ok: false,
    error: "enabled must be a boolean",
  });
  assert.deepEqual(parseAutoTopUpPatch({ enabled: true }), {
    ok: true,
    enabled: true,
    amountUsdMicros: undefined,
  });
  assert.deepEqual(parseAutoTopUpPatch({ enabled: false, amountUsd: "25" }), {
    ok: true,
    enabled: false,
    amountUsdMicros: 25_000_000n,
  });
  assert.deepEqual(parseAutoTopUpPatch({ enabled: true, amountUsd: 10 }), {
    ok: true,
    enabled: true,
    amountUsdMicros: 10_000_000n,
  });
});

test("parseAutoTopUpPatch rejects out-of-range amounts", () => {
  const tooSmall = parseAutoTopUpPatch({ enabled: true, amountUsd: "0.50" });
  assert.equal(tooSmall.ok, false);
  if (!tooSmall.ok) {
    assert.match(tooSmall.error, /between \$1\.00 and \$10,000\.00/);
  }
  assert.equal(
    parseAutoTopUpPatch({ enabled: true, amountUsd: "10000.01" }).ok,
    false,
  );
  assert.equal(
    parseAutoTopUpPatch({ enabled: true, amountUsd: { dollars: 10 } }).ok,
    false,
  );
});

test("serializeAutoTopUpPrefs formats stored micros", () => {
  assert.deepEqual(
    serializeAutoTopUpPrefs({
      enabled: true,
      amountUsdMicros: DEFAULT_AUTO_TOP_UP_USD_MICROS.toString(),
    }),
    { enabled: true, amountUsd: "10.00" },
  );
  assert.deepEqual(
    serializeAutoTopUpPrefs({ enabled: false, amountUsdMicros: null }),
    { enabled: false, amountUsd: null },
  );
  assert.deepEqual(
    serializeAutoTopUpPrefs({ enabled: true, amountUsdMicros: "   " }),
    { enabled: true, amountUsd: null },
  );
  assert.deepEqual(
    serializeAutoTopUpPrefs({ enabled: true, amountUsdMicros: "500000" }),
    { enabled: true, amountUsd: null },
  );
  assert.deepEqual(
    serializeAutoTopUpPrefs({
      enabled: true,
      amountUsdMicros: "not-a-bigint",
    }),
    { enabled: true, amountUsd: null },
  );
});

test("tryAutoTopUpIfEnabled uses the test override", async (t) => {
  t.after(() => __setTryAutoTopUpIfEnabledForTests(null));
  __setTryAutoTopUpIfEnabledForTests(async () => ({
    status: "charged",
    paymentIntentId: "pi_test",
    grantedUsdMicros: "10000000",
  }));
  assert.deepEqual(
    await tryAutoTopUpIfEnabled({
      publicClientId: "app_x",
      externalUserId: "eu_y",
    }),
    {
      status: "charged",
      paymentIntentId: "pi_test",
      grantedUsdMicros: "10000000",
    },
  );
});

test("tryAutoTopUpIfEnabled skips missing identity", async (t) => {
  withRuntime(t);
  assert.deepEqual(
    await tryAutoTopUpIfEnabled({ publicClientId: "  ", externalUserId: "eu" }),
    { status: "skipped", reason: "missing_identity" },
  );
  assert.deepEqual(
    await tryAutoTopUpIfEnabled({ publicClientId: "app_x", externalUserId: "" }),
    { status: "skipped", reason: "missing_identity" },
  );
});

test("tryAutoTopUpIfEnabled skips when the public app is unknown", async (t) => {
  withRuntime(t, { getProviderApp: async () => null });
  assert.deepEqual(
    await tryAutoTopUpIfEnabled(uniqueIds("unknown_app")),
    { status: "skipped", reason: "app_not_found" },
  );
});

test("tryAutoTopUpIfEnabled skips when prefs are disabled", async (t) => {
  withRuntime(t, {
    loadPrefs: async () => ({ enabled: false, amountUsd: "10.00" }),
  });
  assert.deepEqual(
    await tryAutoTopUpIfEnabled(uniqueIds("disabled")),
    { status: "skipped", reason: "disabled" },
  );
});

test("tryAutoTopUpIfEnabled skips owner_rollup billing", async (t) => {
  withRuntime(t, {
    getAppBillingConfig: async () => ({
      billingMode: "owner_rollup",
      stripeConnectedAccountId: "acct_1",
    }),
  });
  assert.deepEqual(
    await tryAutoTopUpIfEnabled(uniqueIds("rollup")),
    { status: "skipped", reason: "not_merchant" },
  );
});

test("tryAutoTopUpIfEnabled skips when billing config is missing", async (t) => {
  withRuntime(t, { getAppBillingConfig: async () => null });
  assert.deepEqual(
    await tryAutoTopUpIfEnabled(uniqueIds("no_billing")),
    { status: "skipped", reason: "not_merchant" },
  );
});

test("tryAutoTopUpIfEnabled skips when Connect is not ready", async (t) => {
  withRuntime(t, {
    getAppBillingConfig: async () => ({
      billingMode: "merchant",
      stripeConnectedAccountId: "  ",
    }),
  });
  assert.deepEqual(
    await tryAutoTopUpIfEnabled(uniqueIds("no_connect")),
    { status: "skipped", reason: "connect_not_ready" },
  );
});

test("tryAutoTopUpIfEnabled skips without a default payment method", async (t) => {
  withRuntime(t, {
    listAppUserPaymentMethods: async () => [
      { id: "pm_other", isDefault: false },
    ],
  });
  assert.deepEqual(
    await tryAutoTopUpIfEnabled(uniqueIds("no_pm")),
    { status: "skipped", reason: "no_payment_method" },
  );
});

test("tryAutoTopUpIfEnabled skips when the default payment method has no id", async (t) => {
  withRuntime(t, {
    listAppUserPaymentMethods: async () => [{ id: "", isDefault: true }],
  });
  assert.deepEqual(
    await tryAutoTopUpIfEnabled(uniqueIds("empty_pm")),
    { status: "skipped", reason: "no_payment_method" },
  );
});

test("tryAutoTopUpIfEnabled skips when the Connect customer id is blank", async (t) => {
  withRuntime(t, {
    getAppUserStripeCustomer: async () => ({
      stripeCustomerId: "  ",
      stripeConnectedAccountId: "acct_1",
    }),
  });
  assert.deepEqual(
    await tryAutoTopUpIfEnabled(uniqueIds("blank_cus")),
    { status: "skipped", reason: "no_stripe_customer" },
  );
});

test("tryAutoTopUpIfEnabled skips when the customer is on another account", async (t) => {
  withRuntime(t, {
    getAppUserStripeCustomer: async () => ({
      stripeCustomerId: "cus_1",
      stripeConnectedAccountId: "acct_other",
    }),
  });
  assert.deepEqual(
    await tryAutoTopUpIfEnabled(uniqueIds("cus_mismatch")),
    { status: "skipped", reason: "no_stripe_customer" },
  );
});

test("tryAutoTopUpIfEnabled charges, grants, and uses the parsed amount", async (t) => {
  let charged: unknown;
  let granted: unknown;
  withRuntime(t, {
    loadPrefs: async () => ({ enabled: true, amountUsd: "25.00" }),
    getAppBillingConfig: async () => ({
      billingMode: "merchant",
      stripeConnectedAccountId: "acct_1",
      defaultCurrency: null,
      applicationFeeBps: null,
    }),
    createConnectedOffSessionPaymentIntent: async (input) => {
      charged = input;
      return { id: "pi_25", status: "succeeded" };
    },
    grantAllowanceUsdMicros: async (input) => {
      granted = input;
      return GRANT_RESULT;
    },
  });

  const ids = uniqueIds("charge");
  assert.deepEqual(await tryAutoTopUpIfEnabled(ids), {
    status: "charged",
    paymentIntentId: "pi_25",
    grantedUsdMicros: "25000000",
  });
  assert.equal((charged as { amountCents: number }).amountCents, 2500);
  assert.equal((charged as { currency: string }).currency, "usd");
  assert.equal((charged as { applicationFeeBps: number }).applicationFeeBps, 0);
  assert.equal(
    (charged as { metadata: Record<string, string> }).metadata[
      LEGACY_AUTO_TOP_UP_METADATA_FLAG
    ],
    "1",
  );
  assert.equal(
    (granted as { amountUsdMicros: bigint }).amountUsdMicros,
    25_000_000n,
  );
  assert.equal(
    (granted as { idempotencyKey: string }).idempotencyKey,
    "autotopup:pi_25",
  );
});

test("tryAutoTopUpIfEnabled falls back to $10 when prefs amount is invalid", async (t) => {
  let amountCents = 0;
  withRuntime(t, {
    loadPrefs: async () => ({ enabled: true, amountUsd: "not-valid" }),
    createConnectedOffSessionPaymentIntent: async (input) => {
      amountCents = input.amountCents;
      return { id: "pi_default", status: "succeeded" };
    },
  });
  const result = await tryAutoTopUpIfEnabled(uniqueIds("default_amt"));
  assert.equal(result.status, "charged");
  assert.equal(amountCents, 1000);
});

test("tryAutoTopUpIfEnabled uses the default amount when prefs omit amountUsd", async (t) => {
  let amountCents = 0;
  withRuntime(t, {
    loadPrefs: async () => ({ enabled: true, amountUsd: null }),
    createConnectedOffSessionPaymentIntent: async (input) => {
      amountCents = input.amountCents;
      return { id: "pi_null_amt", status: "succeeded" };
    },
  });
  const result = await tryAutoTopUpIfEnabled(uniqueIds("null_amt"));
  assert.equal(result.status, "charged");
  assert.equal(amountCents, 1000);
});

test("tryAutoTopUpIfEnabled returns failed when Stripe throws", async (t) => {
  withRuntime(t, {
    createConnectedOffSessionPaymentIntent: async () => {
      throw new Error("card_declined");
    },
  });
  assert.deepEqual(await tryAutoTopUpIfEnabled(uniqueIds("stripe_err")), {
    status: "failed",
    reason: "stripe_charge_failed",
  });
});

test("tryAutoTopUpIfEnabled returns failed when PaymentIntent is not succeeded", async (t) => {
  withRuntime(t, {
    createConnectedOffSessionPaymentIntent: async () => ({
      id: "pi_requires",
      status: "requires_action",
    }),
  });
  assert.deepEqual(await tryAutoTopUpIfEnabled(uniqueIds("pi_status")), {
    status: "failed",
    reason: "stripe_status_requires_action",
  });
});

test("tryAutoTopUpIfEnabled still reports charged when the grant fails", async (t) => {
  withRuntime(t, {
    grantAllowanceUsdMicros: async () => {
      throw new Error("openmeter down");
    },
  });
  assert.deepEqual(await tryAutoTopUpIfEnabled(uniqueIds("grant_fail")), {
    status: "charged",
    paymentIntentId: "pi_ok",
    grantedUsdMicros: "10000000",
  });
});

test("tryAutoTopUpIfEnabled uses live collaborators when no runtime is injected", async (t) => {
  t.after(() => {
    __setAutoTopUpRuntimeForTests(null);
    __setTryAutoTopUpIfEnabledForTests(null);
  });
  __setAutoTopUpRuntimeForTests(null);
  __setTryAutoTopUpIfEnabledForTests(null);
  try {
    const result = await tryAutoTopUpIfEnabled(uniqueIds("live_runtime"));
    assert.equal(result.status, "skipped");
    assert.equal(result.reason, "app_not_found");
  } catch (err) {
    assert.ok(err instanceof Error);
  }
});

test("test-only auto-top-up hooks reject outside NODE_ENV=test", () => {
  const env = process.env as { NODE_ENV?: string };
  const previous = env.NODE_ENV;
  env.NODE_ENV = "production";
  try {
    assert.throws(
      () => __setAutoTopUpRuntimeForTests(null),
      /only available in test/,
    );
    assert.throws(
      () => __setTryAutoTopUpIfEnabledForTests(null),
      /only available in test/,
    );
  } finally {
    if (previous === undefined) {
      delete env.NODE_ENV;
    } else {
      env.NODE_ENV = previous;
    }
  }
});
