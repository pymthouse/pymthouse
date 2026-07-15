import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  x402PaymentRequirementsSchema,
  x402VerifyRequestSchema,
} from "@/lib/x402/schemas";
import { usdcAtomicToUsdMicros } from "@/lib/x402/settle";
import { checkRateLimit, resetRateLimitsForTests } from "@/lib/x402/rate-limit";
import { listSupportedKinds, getX402Network } from "@/lib/x402/networks";
import { encodePaymentRequiredHeader } from "@/lib/x402/payment-required";

describe("x402 schemas", () => {
  it("parses exact payment requirements", () => {
    const parsed = x402PaymentRequirementsSchema.parse({
      scheme: "exact",
      network: "eip155:42161",
      asset: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831",
      amount: "10000",
      payTo: "0x0000000000000000000000000000000000000001",
      extra: { name: "USD Coin", version: "2" },
    });
    assert.equal(parsed.scheme, "exact");
    assert.equal(parsed.maxTimeoutSeconds, 300);
  });

  it("rejects invalid verify bodies", () => {
    const result = x402VerifyRequestSchema.safeParse({ paymentPayload: {} });
    assert.equal(result.success, false);
  });
});

describe("x402 networks", () => {
  it("lists Arbitrum mainnet and sepolia", () => {
    const kinds = listSupportedKinds();
    assert.ok(kinds.some((k) => k.network === "eip155:42161"));
    assert.ok(kinds.some((k) => k.network === "eip155:421614"));
    assert.equal(getX402Network("eip155:1"), null);
  });
});

describe("usdcAtomicToUsdMicros", () => {
  it("maps 6-decimal USDC 1:1 to micros", () => {
    assert.equal(usdcAtomicToUsdMicros("10000"), 10000n);
  });
});

describe("rate limit", () => {
  it("blocks after limit", () => {
    resetRateLimitsForTests();
    const key = "test-key";
    for (let i = 0; i < 3; i++) {
      assert.equal(checkRateLimit({ key, limit: 3, windowMs: 60_000 }).allowed, true);
    }
    assert.equal(checkRateLimit({ key, limit: 3, windowMs: 60_000 }).allowed, false);
  });
});

describe("payment-required header", () => {
  it("encodes base64 JSON", () => {
    const header = encodePaymentRequiredHeader([
      {
        scheme: "exact",
        network: "eip155:42161",
        asset: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831",
        amount: "10000",
        payTo: "0x0000000000000000000000000000000000000001",
        maxTimeoutSeconds: 300,
        extra: { name: "USD Coin", version: "2" },
      },
    ]);
    const decoded = JSON.parse(Buffer.from(header, "base64").toString("utf8"));
    assert.equal(decoded.x402Version, 2);
    assert.equal(decoded.accepts.length, 1);
  });
});
