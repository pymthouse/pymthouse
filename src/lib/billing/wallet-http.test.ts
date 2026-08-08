import assert from "node:assert/strict";
import test from "node:test";

import { clampPageParam, walletUpstreamErrorResponse } from "@/lib/billing/wallet-http";

test("clampPageParam accepts whole positive integers and clamps to max", () => {
  assert.equal(clampPageParam("1", 1, 100), 1);
  assert.equal(clampPageParam("20", 1, 100), 20);
  assert.equal(clampPageParam("999", 1, 100), 100);
  assert.equal(clampPageParam(" 3 ", 1, 100), 3);
});

test("clampPageParam rejects fractional and non-integer strings", () => {
  assert.equal(clampPageParam("2.9", 1, 100), 1);
  assert.equal(clampPageParam("25junk", 20, 100), 20);
  assert.equal(clampPageParam("0", 1, 100), 1);
  assert.equal(clampPageParam("-3", 1, 100), 1);
  assert.equal(clampPageParam("", 7, 100), 7);
  assert.equal(clampPageParam(null, 7, 100), 7);
  assert.equal(clampPageParam("1e2", 7, 100), 7);
});

test("walletUpstreamErrorResponse maps Connect-not-ready to 409", async () => {
  const res = walletUpstreamErrorResponse(
    new Error("Merchant Stripe Connect is not ready to accept payments"),
    "top-up checkout",
  );
  assert.equal(res.status, 409);
  const json = (await res.json()) as { error?: string };
  assert.equal(
    json.error,
    "Merchant Stripe Connect is not ready to accept payments",
  );
});
