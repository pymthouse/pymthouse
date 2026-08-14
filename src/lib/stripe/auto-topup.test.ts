import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_AUTO_TOP_UP_USD_MICROS,
  parseAutoTopUpPatch,
  serializeAutoTopUpPrefs,
  tryAutoTopUpIfEnabled,
  __setTryAutoTopUpIfEnabledForTests,
} from "@/lib/stripe/auto-topup";

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
});

test("parseAutoTopUpPatch rejects out-of-range amounts", () => {
  assert.equal(parseAutoTopUpPatch({ enabled: true, amountUsd: "0.50" }).ok, false);
  assert.equal(
    parseAutoTopUpPatch({ enabled: true, amountUsd: "10000.01" }).ok,
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
