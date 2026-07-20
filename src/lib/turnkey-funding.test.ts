import test from "node:test";
import assert from "node:assert/strict";
import {
  allocateDepositAndReserve,
  getTurnkeyFundingConfig,
  parseTurnkeyBalanceWebhookPayload,
  shouldProcessTurnkeyDeposit,
  type TurnkeyBalanceWebhookPayload,
} from "./turnkey-funding";

const SIGNER_ADDRESS = "0x6CAE3C7aa09Adf84C0eD1C3A53465364cEcb7260";

function basePayload(
  overrides: Partial<TurnkeyBalanceWebhookPayload> = {},
): TurnkeyBalanceWebhookPayload {
  return {
    type: "balances:finalized",
    msg: {
      operation: "deposit",
      caip2: "eip155:42161",
      txHash: "0xabc",
      address: SIGNER_ADDRESS,
      idempotencyKey: "idem-1",
      asset: {
        symbol: "ETH",
        caip19: "eip155:42161/slip44:60",
        amount: "2000000000000000",
      },
    },
    ...overrides,
  };
}

test("getTurnkeyFundingConfig uses defaults", () => {
  const prevCaip2 = process.env.TURNKEY_FUNDING_CAIP2;
  const prevBuffer = process.env.TICKET_FUNDING_GAS_BUFFER_WEI;
  const prevMin = process.env.TICKET_FUNDING_MIN_WEI;
  const prevReserve = process.env.RESERVE_AMOUNT;
  delete process.env.TURNKEY_FUNDING_CAIP2;
  delete process.env.TICKET_FUNDING_GAS_BUFFER_WEI;
  delete process.env.TICKET_FUNDING_MIN_WEI;
  delete process.env.RESERVE_AMOUNT;

  const config = getTurnkeyFundingConfig();
  assert.equal(config.caip2, "eip155:42161");
  assert.equal(config.gasBufferWei, 100_000_000_000_000n);
  assert.equal(config.minFundWei, 1_000_000_000_000_000n);
  assert.equal(config.reserveAmountWei, 250_000_000_000_000_000n);

  if (prevCaip2 !== undefined) process.env.TURNKEY_FUNDING_CAIP2 = prevCaip2;
  if (prevBuffer !== undefined) {
    process.env.TICKET_FUNDING_GAS_BUFFER_WEI = prevBuffer;
  }
  if (prevMin !== undefined) process.env.TICKET_FUNDING_MIN_WEI = prevMin;
  if (prevReserve !== undefined) process.env.RESERVE_AMOUNT = prevReserve;
});

test("getTurnkeyFundingConfig loads RESERVE_AMOUNT", () => {
  const prevReserve = process.env.RESERVE_AMOUNT;
  process.env.RESERVE_AMOUNT = "5000000000000000000";
  try {
    assert.equal(
      getTurnkeyFundingConfig().reserveAmountWei,
      5_000_000_000_000_000_000n,
    );
  } finally {
    if (prevReserve !== undefined) process.env.RESERVE_AMOUNT = prevReserve;
    else delete process.env.RESERVE_AMOUNT;
  }
});

test("parseTurnkeyBalanceWebhookPayload rejects invalid JSON", () => {
  assert.equal(parseTurnkeyBalanceWebhookPayload("not-json"), null);
});

test("shouldProcessTurnkeyDeposit skips non-finalized events", async () => {
  const config = getTurnkeyFundingConfig();
  const decision = await shouldProcessTurnkeyDeposit(
    basePayload({ type: "balances:confirmed" }),
    config,
  );
  assert.deepEqual(decision, { action: "skip", reason: "not_finalized" });
});

test("shouldProcessTurnkeyDeposit skips wrong chain", async () => {
  const config = getTurnkeyFundingConfig();
  const decision = await shouldProcessTurnkeyDeposit(
    basePayload({
      msg: {
        ...basePayload().msg!,
        caip2: "eip155:1",
      },
    }),
    config,
  );
  assert.deepEqual(decision, { action: "skip", reason: "wrong_chain" });
});

test("shouldProcessTurnkeyDeposit skips wrong address", async () => {
  const config = getTurnkeyFundingConfig();
  const decision = await shouldProcessTurnkeyDeposit(
    basePayload({
      msg: {
        ...basePayload().msg!,
        address: "0x0000000000000000000000000000000000000001",
      },
    }),
    config,
    { signerAddress: SIGNER_ADDRESS },
  );
  assert.deepEqual(decision, { action: "skip", reason: "wrong_address" });
});

test("shouldProcessTurnkeyDeposit funds matching deposit", async () => {
  const config = getTurnkeyFundingConfig();
  const decision = await shouldProcessTurnkeyDeposit(
    basePayload(),
    config,
    { signerAddress: SIGNER_ADDRESS },
  );
  assert.equal(decision.action, "fund");
  if (decision.action === "fund") {
    assert.equal(decision.idempotencyKey, "idem-1");
    assert.equal(decision.amountWei, 2_000_000_000_000_000n);
    assert.equal(decision.fundWei, 1_900_000_000_000_000n);
  }
});

test("shouldProcessTurnkeyDeposit skips below minimum fund", async () => {
  const config = getTurnkeyFundingConfig();
  const decision = await shouldProcessTurnkeyDeposit(
    basePayload({
      msg: {
        ...basePayload().msg!,
        asset: {
          symbol: "ETH",
          caip19: "eip155:42161/slip44:60",
          amount: "1005000000000000",
        },
      },
    }),
    config,
    { signerAddress: SIGNER_ADDRESS },
  );
  assert.deepEqual(decision, { action: "skip", reason: "below_min_fund" });
});

test("allocateDepositAndReserve fills reserve until RESERVE_AMOUNT", () => {
  // Shortfall 1000; fund 3000 → 1000 to reserve, remainder to deposit
  assert.deepEqual(allocateDepositAndReserve(3_000n, 4_000n, 5_000n), {
    depositWei: 2_000n,
    reserveWei: 1_000n,
  });
  // Fund entirely below shortfall → all to reserve
  assert.deepEqual(allocateDepositAndReserve(1_000n, 0n, 5_000n), {
    depositWei: 0n,
    reserveWei: 1_000n,
  });
  // Exact shortfall → all to reserve
  assert.deepEqual(allocateDepositAndReserve(1_000n, 4_000n, 5_000n), {
    depositWei: 0n,
    reserveWei: 1_000n,
  });
});

test("allocateDepositAndReserve sends 100% to deposit once reserve is full", () => {
  assert.deepEqual(allocateDepositAndReserve(1_000n, 5_000n, 5_000n), {
    depositWei: 1_000n,
    reserveWei: 0n,
  });
  assert.deepEqual(allocateDepositAndReserve(1_000n, 5_001n, 5_000n), {
    depositWei: 1_000n,
    reserveWei: 0n,
  });
  // RESERVE_AMOUNT=0 → always all to deposit
  assert.deepEqual(allocateDepositAndReserve(1_000n, 0n, 0n), {
    depositWei: 1_000n,
    reserveWei: 0n,
  });
});
