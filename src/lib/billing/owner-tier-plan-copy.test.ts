import assert from "node:assert/strict";
import test from "node:test";

import {
  buildOwnerTierCheckoutBullets,
  estimateIncludedApiCalls,
  formatRoughApiCallCount,
  ownerTierIncludedUsageBullet,
} from "@/lib/billing/owner-tier-plan-copy";

test("formatRoughApiCallCount scales to M and K", () => {
  assert.equal(formatRoughApiCallCount(5_000_000n), "5 M");
  assert.equal(formatRoughApiCallCount(3_000_000n), "3 M");
  assert.equal(formatRoughApiCallCount(1_500_000n), "1.5 M");
  assert.equal(formatRoughApiCallCount(500_000n), "500 K");
  assert.equal(formatRoughApiCallCount(42n), "42");
});

test("estimateIncludedApiCalls uses allowance ÷ overage rate", () => {
  assert.equal(estimateIncludedApiCalls("5000000", "0.000001"), 5_000_000n);
  assert.equal(estimateIncludedApiCalls("10000000", "0.000001"), 10_000_000n);
  assert.equal(estimateIncludedApiCalls("2500000", "0.000001"), 2_500_000n);
  assert.equal(estimateIncludedApiCalls("0", "0.000001"), null);
});

test("ownerTierIncludedUsageBullet reflects live micros", () => {
  const bullet = ownerTierIncludedUsageBullet("10000000", "0.000001");
  assert.match(bullet, /\$10\.00 included usage/);
  assert.match(bullet, /10 M API calls/);
});

test("buildOwnerTierCheckoutBullets prefers admin description lines", () => {
  const bullets = buildOwnerTierCheckoutBullets({
    includedUsdMicros: "5000000",
    overageRateUsd: "0.000001",
    description: "Unlimited API keys\nPriority routing",
    featureBullets: ["Should not appear"],
  });
  assert.equal(bullets.length, 3);
  assert.match(bullets[0]!, /\$5\.00 included/);
  assert.equal(bullets[1], "Unlimited API keys");
  assert.equal(bullets[2], "Priority routing");
});

test("buildOwnerTierCheckoutBullets falls back to feature bullets", () => {
  const bullets = buildOwnerTierCheckoutBullets({
    includedUsdMicros: "3000000",
    description: null,
    featureBullets: ["Monetisation features available immediately"],
  });
  assert.equal(bullets.length, 2);
  assert.match(bullets[0]!, /\$3\.00 included/);
  assert.equal(bullets[1], "Monetisation features available immediately");
});
