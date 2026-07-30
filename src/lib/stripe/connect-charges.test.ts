import test from "node:test";
import assert from "node:assert/strict";
import { createOffSessionConnectedPaymentIntent } from "./connect-charges";

test("createOffSessionConnectedPaymentIntent posts PI with Stripe-Account and Idempotency-Key", async (t) => {
  const savedKey = process.env.STRIPE_SECRET_KEY;
  process.env.STRIPE_SECRET_KEY = "sk_test_connect_charges";

  const calls: Array<{
    url: string;
    headers: Record<string, string>;
    body: string;
  }> = [];

  t.mock.method(globalThis, "fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const headers: Record<string, string> = {};
    const h = init?.headers;
    if (h && typeof h === "object" && !(h instanceof Headers)) {
      Object.assign(headers, h as Record<string, string>);
    }
    calls.push({
      url,
      headers,
      body: String(init?.body ?? ""),
    });
    return new Response(
      JSON.stringify({ id: "pi_test_123", status: "processing" }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  });

  t.after(() => {
    process.env.STRIPE_SECRET_KEY = savedKey;
  });

  const result = await createOffSessionConnectedPaymentIntent({
    accountId: "acct_merchant",
    customerId: "cus_enduser",
    amountCents: 1234,
    applicationFeeBps: 250,
    idempotencyKey: "01G65Z755AFWAKHE12NY0CQ9FH",
    metadata: { openmeter_invoice_id: "01G65Z755AFWAKHE12NY0CQ9FH" },
  });

  assert.equal(result.kind, "payment_intent");
  if (result.kind === "payment_intent") {
    assert.equal(result.paymentIntentId, "pi_test_123");
    assert.equal(result.applicationFeeAmount, 30); // floor(1234 * 250 / 10000)
  }
  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /\/v1\/payment_intents$/);
  assert.equal(calls[0].headers["Stripe-Account"], "acct_merchant");
  assert.equal(
    calls[0].headers["Idempotency-Key"],
    "01G65Z755AFWAKHE12NY0CQ9FH",
  );
  assert.match(calls[0].body, /off_session=true/);
  assert.match(calls[0].body, /confirm=true/);
  assert.match(calls[0].body, /application_fee_amount=30/);
});
