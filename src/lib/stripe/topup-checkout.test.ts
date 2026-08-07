import assert from "node:assert/strict";
import test from "node:test";

import {
  parseTopUpAmountUsd,
  parseTopUpCheckoutSessionCompleted,
  resolveTopUpReturnUrl,
  topUpGrantIdempotencyKey,
  TOP_UP_MAX_USD_MICROS,
  TOP_UP_MIN_USD_MICROS,
} from "@/lib/stripe/topup-checkout";

test("parseTopUpAmountUsd converts dollar input to USD micros", () => {
  assert.deepEqual(parseTopUpAmountUsd("25"), { ok: true, amountUsdMicros: 25_000_000n });
  assert.deepEqual(parseTopUpAmountUsd("25.00"), { ok: true, amountUsdMicros: 25_000_000n });
  assert.deepEqual(parseTopUpAmountUsd("1.5"), { ok: true, amountUsdMicros: 1_500_000n });
  assert.deepEqual(parseTopUpAmountUsd(100), { ok: true, amountUsdMicros: 100_000_000n });
});

test("parseTopUpAmountUsd enforces the $1–$10,000 window", () => {
  assert.deepEqual(parseTopUpAmountUsd("1"), { ok: true, amountUsdMicros: TOP_UP_MIN_USD_MICROS });
  assert.deepEqual(parseTopUpAmountUsd("10000"), {
    ok: true,
    amountUsdMicros: TOP_UP_MAX_USD_MICROS,
  });
  assert.equal(parseTopUpAmountUsd("0.99").ok, false);
  assert.equal(parseTopUpAmountUsd("10000.01").ok, false);
});

test("parseTopUpAmountUsd rejects malformed input", () => {
  for (const bad of ["", "abc", "-5", "1.234", "$25", "25,000", null, undefined, {}]) {
    assert.equal(parseTopUpAmountUsd(bad).ok, false, `expected rejection for ${JSON.stringify(bad)}`);
  }
  assert.equal(parseTopUpAmountUsd(Number.POSITIVE_INFINITY).ok, false);
});

test("topUpGrantIdempotencyKey is stable per Checkout session", () => {
  assert.equal(topUpGrantIdempotencyKey("cs_test_123"), "topup:cs_test_123");
  assert.equal(topUpGrantIdempotencyKey(" cs_test_123 "), "topup:cs_test_123");
  // Idempotent charge on retry: the same session always maps to the same key.
  assert.equal(
    topUpGrantIdempotencyKey("cs_test_123"),
    topUpGrantIdempotencyKey("cs_test_123"),
  );
});

test("resolveTopUpReturnUrl allows https and localhost, falls back otherwise", () => {
  const fallback = "https://pymthouse.example/billing";
  assert.equal(
    resolveTopUpReturnUrl("https://dash.partner.example/wallet", fallback),
    "https://dash.partner.example/wallet",
  );
  assert.equal(
    resolveTopUpReturnUrl("http://localhost:3001/billing", fallback),
    "http://localhost:3001/billing",
  );
  assert.equal(resolveTopUpReturnUrl("http://evil.example/x", fallback), fallback);
  assert.equal(resolveTopUpReturnUrl("javascript:alert(1)", fallback), fallback);
  assert.equal(resolveTopUpReturnUrl("not a url", fallback), fallback);
  assert.equal(resolveTopUpReturnUrl(undefined, fallback), fallback);
});

function topUpEventBody(overrides: {
  session?: Record<string, unknown>;
  metadata?: Record<string, unknown> | null;
  type?: string;
}): string {
  const metadata =
    overrides.metadata === null
      ? undefined
      : {
          pymthouse_topup: "1",
          owner_user_id: "user_1",
          client_id: "app_pub_1",
          amount_usd_micros: "25000000",
          ...overrides.metadata,
        };
  return JSON.stringify({
    type: overrides.type ?? "checkout.session.completed",
    data: {
      object: {
        id: "cs_test_abc",
        mode: "payment",
        payment_status: "paid",
        amount_total: 2500,
        metadata,
        ...overrides.session,
      },
    },
  });
}

test("parseTopUpCheckoutSessionCompleted extracts a paid top-up", () => {
  assert.deepEqual(parseTopUpCheckoutSessionCompleted(topUpEventBody({})), {
    sessionId: "cs_test_abc",
    ownerUserId: "user_1",
    clientId: "app_pub_1",
    amountUsdMicros: 25_000_000n,
  });
});

test("parseTopUpCheckoutSessionCompleted settles async_payment_succeeded", () => {
  assert.deepEqual(
    parseTopUpCheckoutSessionCompleted(
      topUpEventBody({ type: "checkout.session.async_payment_succeeded" }),
    ),
    {
      sessionId: "cs_test_abc",
      ownerUserId: "user_1",
      clientId: "app_pub_1",
      amountUsdMicros: 25_000_000n,
    },
  );
});

test("parseTopUpCheckoutSessionCompleted ignores non-top-up sessions", () => {
  // Setup-mode Checkout (payment-method save) must never credit.
  assert.equal(
    parseTopUpCheckoutSessionCompleted(
      topUpEventBody({ session: { mode: "setup", payment_status: "no_payment_required" } }),
    ),
    null,
  );
  // Unpaid async payment methods settle later via checkout.session.async_payment_succeeded.
  assert.equal(
    parseTopUpCheckoutSessionCompleted(
      topUpEventBody({ session: { payment_status: "unpaid" } }),
    ),
    null,
  );
  // Foreign metadata (not created by the wallet route).
  assert.equal(parseTopUpCheckoutSessionCompleted(topUpEventBody({ metadata: null })), null);
  // Wrong event type.
  assert.equal(
    parseTopUpCheckoutSessionCompleted(topUpEventBody({ type: "checkout.session.expired" })),
    null,
  );
  // Malformed JSON.
  assert.equal(parseTopUpCheckoutSessionCompleted("{nope"), null);
});

test("parseTopUpCheckoutSessionCompleted refuses amount mismatches", () => {
  // Metadata says $25 but Stripe charged $99 — refuse to credit either number.
  assert.equal(
    parseTopUpCheckoutSessionCompleted(
      topUpEventBody({ session: { amount_total: 9900 } }),
    ),
    null,
  );
  // Missing / non-integer amount_total.
  assert.equal(
    parseTopUpCheckoutSessionCompleted(topUpEventBody({ session: { amount_total: null } })),
    null,
  );
  assert.equal(
    parseTopUpCheckoutSessionCompleted(topUpEventBody({ session: { amount_total: 25.5 } })),
    null,
  );
});

test("parseTopUpCheckoutSessionCompleted requires owner and client identity", () => {
  assert.equal(
    parseTopUpCheckoutSessionCompleted(topUpEventBody({ metadata: { owner_user_id: "" } })),
    null,
  );
  assert.equal(
    parseTopUpCheckoutSessionCompleted(topUpEventBody({ metadata: { client_id: "" } })),
    null,
  );
});
