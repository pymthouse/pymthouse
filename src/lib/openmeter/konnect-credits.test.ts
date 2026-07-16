import test from "node:test";
import assert from "node:assert/strict";

import {
  createKonnectCreditGrant,
  decimalDollarsToUsdMicros,
  getKonnectCreditBalance,
  usdMicrosToDecimalDollars,
} from "./konnect-credits";

test("usdMicrosToDecimalDollars converts whole and fractional dollars", () => {
  assert.equal(usdMicrosToDecimalDollars(5_000_000n), "5");
  assert.equal(usdMicrosToDecimalDollars(5_250_000n), "5.25");
  assert.equal(usdMicrosToDecimalDollars(1n), "0.000001");
  assert.equal(usdMicrosToDecimalDollars(0n), "0");
});

test("decimalDollarsToUsdMicros converts Konnect decimal strings", () => {
  assert.equal(decimalDollarsToUsdMicros("5"), 5_000_000n);
  assert.equal(decimalDollarsToUsdMicros("5.00"), 5_000_000n);
  assert.equal(decimalDollarsToUsdMicros("5.25"), 5_250_000n);
  assert.equal(decimalDollarsToUsdMicros("0.000001"), 1n);
  assert.equal(decimalDollarsToUsdMicros("0.000034"), 34n);
  assert.equal(decimalDollarsToUsdMicros("4.999966"), 4_999_966n);
  assert.equal(decimalDollarsToUsdMicros("-1.5"), -1_500_000n);
  // Truncate past micro precision (do not invent balance).
  assert.equal(decimalDollarsToUsdMicros("0.0000349"), 34n);
});

test("usdMicrosToDecimalDollars round-trips ceil-sized live-runner fees", () => {
  for (const micros of [1n, 34n, 100n, 612n, 5_000_000n]) {
    assert.equal(decimalDollarsToUsdMicros(usdMicrosToDecimalDollars(micros)), micros);
  }
});

test("getKonnectCreditBalance maps live balance and active grants", async () => {
  const previousKey = process.env.OPENMETER_API_KEY;
  const previousUrl = process.env.OPENMETER_URL;
  process.env.OPENMETER_API_KEY = "spat_test";
  process.env.OPENMETER_URL = "https://us.api.konghq.com/v3/openmeter";

  const originalFetch = globalThis.fetch;
  const calls: Array<{ url: string; method: string; body?: string }> = [];

  globalThis.fetch = (async (input, init) => {
    const url = input instanceof Request ? input.url : input.toString();
    const method = (init?.method ?? "GET").toUpperCase();
    const body = typeof init?.body === "string" ? init.body : undefined;
    calls.push({ url, method, body });

    if (url.includes("/credits/balance")) {
      return new Response(
        JSON.stringify({
          balances: [{ currency: "USD", live: "44.78", settled: "44.78", pending: "0" }],
          retrieved_at: "2026-07-11T00:00:00Z",
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    if (url.includes("/credits/grants") && method === "GET") {
      return new Response(
        JSON.stringify({
          data: [
            { amount: "50.00", currency: "USD", status: "active" },
            { amount: "10.00", currency: "USD", status: "inactive" },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    throw new Error(`unexpected fetch: ${method} ${url}`);
  }) as typeof fetch;

  try {
    const balance = await getKonnectCreditBalance({
      customerId: "01KW2BBAK6V8K9B2K83SX1MW03",
    });
    assert.ok(balance);
    assert.equal(balance.balanceUsdMicros, 44_780_000n);
    assert.equal(balance.lifetimeGrantedUsdMicros, 50_000_000n);
    assert.equal(balance.consumedUsdMicros, 5_220_000n);
    assert.equal(calls.length, 2);
    assert.match(calls[0].url, /credits\/balance/);
    assert.match(calls[1].url, /credits\/grants/);
  } finally {
    globalThis.fetch = originalFetch;
    if (previousKey === undefined) {
      delete process.env.OPENMETER_API_KEY;
    } else {
      process.env.OPENMETER_API_KEY = previousKey;
    }
    if (previousUrl === undefined) {
      delete process.env.OPENMETER_URL;
    } else {
      process.env.OPENMETER_URL = previousUrl;
    }
  }
});

test("createKonnectCreditGrant posts decimal dollars and treats 409 as idempotent", async () => {
  const previousKey = process.env.OPENMETER_API_KEY;
  const previousUrl = process.env.OPENMETER_URL;
  process.env.OPENMETER_API_KEY = "spat_test";
  process.env.OPENMETER_URL = "https://us.api.konghq.com/v3/openmeter";

  const originalFetch = globalThis.fetch;
  let postedBody: Record<string, unknown> | null = null;
  let status = 201;

  globalThis.fetch = (async (_input, init) => {
    postedBody = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    return new Response(status === 201 ? JSON.stringify({ id: "grant_1" }) : "{}", {
      status,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;

  try {
    const created = await createKonnectCreditGrant({
      customerId: "01KW2BBAK6V8K9B2K83SX1MW03",
      amountUsdMicros: 5_000_000n,
      name: "Starter trial credits",
      featureKey: "network_spend",
      idempotencyKey: "starter:01KW2BBAK6V8K9B2K83SX1MW03:network_spend",
    });
    assert.deepEqual(created, { created: true, conflict: false });
    assert.ok(postedBody);
    assert.equal(postedBody["amount"], "5");
    assert.equal(postedBody["funding_method"], "none");
    assert.equal(postedBody["currency"], "USD");
    assert.equal(
      postedBody["key"],
      "starter:01KW2BBAK6V8K9B2K83SX1MW03:network_spend",
    );
    assert.deepEqual(postedBody["filters"], { features: ["network_spend"] });

    status = 409;
    const conflict = await createKonnectCreditGrant({
      customerId: "01KW2BBAK6V8K9B2K83SX1MW03",
      amountUsdMicros: 5_000_000n,
      name: "Starter trial credits",
      featureKey: "network_spend",
      idempotencyKey: "starter:01KW2BBAK6V8K9B2K83SX1MW03:network_spend",
    });
    assert.deepEqual(conflict, { created: false, conflict: true });
  } finally {
    globalThis.fetch = originalFetch;
    if (previousKey === undefined) {
      delete process.env.OPENMETER_API_KEY;
    } else {
      process.env.OPENMETER_API_KEY = previousKey;
    }
    if (previousUrl === undefined) {
      delete process.env.OPENMETER_URL;
    } else {
      process.env.OPENMETER_URL = previousUrl;
    }
  }
});
