import test from "node:test";
import assert from "node:assert/strict";
import { computeUsdMicrosFromWei } from "@/lib/billing-runtime";
import {
  ARBITRUM_MAINNET_CAIP2,
  isArbitrumMainnetCaip2,
  isBalanceFinalizedEvent,
  isDepositOperation,
  parseBalanceFinalizedMessage,
} from "./deposit-assets";

test("parseBalanceFinalizedMessage extracts deposit fields", () => {
  const parsed = parseBalanceFinalizedMessage({
    eventType: "BALANCE_FINALIZED_UPDATES",
    message: {
      idempotencyKey: "idem-1",
      walletAddress: "0xAbCdEf0123456789012345678901234567890AbCd",
      caip2: ARBITRUM_MAINNET_CAIP2,
      operation: "deposit",
      transactionHash: "0x" + "a".repeat(64),
      value: "1000000000000000000",
    },
  });

  assert.ok(parsed);
  assert.equal(parsed?.idempotencyKey, "idem-1");
  assert.equal(parsed?.operation, "deposit");
  assert.equal(parsed?.amountWei, "1000000000000000000");
});

test("isArbitrumMainnetCaip2 and isDepositOperation", () => {
  assert.equal(isArbitrumMainnetCaip2("eip155:42161"), true);
  assert.equal(isArbitrumMainnetCaip2("eip155:1"), false);
  assert.equal(isDepositOperation("deposit"), true);
  assert.equal(isDepositOperation("withdraw"), false);
});

test("isBalanceFinalizedEvent accepts known event types", () => {
  assert.equal(isBalanceFinalizedEvent({ eventType: "BALANCE_FINALIZED_UPDATES" }), true);
  assert.equal(isBalanceFinalizedEvent({ eventType: "balances:finalized" }), true);
  assert.equal(isBalanceFinalizedEvent({ eventType: "OTHER" }), false);
});

test("ETH to USD micros conversion for deposit amount", () => {
  const oneEth = 1_000_000_000_000_000_000n;
  const usdMicros = computeUsdMicrosFromWei(oneEth, 3500);
  assert.equal(usdMicros, 3_500_000_000n);
});

test("idempotency: duplicate idempotency keys should dedupe at DB layer", () => {
  const a = parseBalanceFinalizedMessage({
    message: { idempotencyKey: "same-key", walletAddress: "0x" + "1".repeat(40), caip2: ARBITRUM_MAINNET_CAIP2, operation: "deposit", value: "1" },
  });
  const b = parseBalanceFinalizedMessage({
    message: { idempotencyKey: "same-key", walletAddress: "0x" + "2".repeat(40), caip2: ARBITRUM_MAINNET_CAIP2, operation: "deposit", value: "2" },
  });
  assert.equal(a?.idempotencyKey, b?.idempotencyKey);
});
