import test from "node:test";
import assert from "node:assert/strict";
import type { SenderInfo } from "@/lib/signer-cli";
import {
  decideFunding,
  getSignerReserveFloorWei,
} from "@/lib/signer/fund-deposit";

const floor = 10_000_000_000_000_000n; // 0.01 ETH

test("decideFunding uses deposit_and_reserve on first fund", () => {
  const decision = decideFunding(null, 1_000_000_000_000_000_000n, floor);
  assert.equal(decision.mode, "deposit_and_reserve");
  assert.equal(decision.depositWei + decision.reserveWei, 1_000_000_000_000_000_000n);
  assert.ok(decision.reserveWei > 0n);
});

test("decideFunding tops up reserve when below floor", () => {
  const senderInfo: SenderInfo = {
    deposit: "1000000000000000000",
    withdrawRound: "0",
    reserve: { fundsRemaining: "0", claimedInCurrentRound: "0" },
  };
  const decision = decideFunding(senderInfo, 500_000_000_000_000_000n, floor);
  assert.equal(decision.mode, "deposit_and_reserve");
  assert.ok(decision.reserveWei > 0n);
});

test("decideFunding uses fundDeposit when reserve is healthy", () => {
  const senderInfo: SenderInfo = {
    deposit: "1000000000000000000",
    withdrawRound: "0",
    reserve: { fundsRemaining: floor.toString(), claimedInCurrentRound: "0" },
  };
  const decision = decideFunding(senderInfo, 500_000_000_000_000_000n, floor);
  assert.equal(decision.mode, "deposit");
  assert.equal(decision.depositWei, 500_000_000_000_000_000n);
  assert.equal(decision.reserveWei, 0n);
});

test("getSignerReserveFloorWei reads env override", () => {
  const prev = process.env.SIGNER_RESERVE_FLOOR_WEI;
  process.env.SIGNER_RESERVE_FLOOR_WEI = "5000000000000000";
  assert.equal(getSignerReserveFloorWei(), 5_000_000_000_000_000n);
  if (prev === undefined) delete process.env.SIGNER_RESERVE_FLOOR_WEI;
  else process.env.SIGNER_RESERVE_FLOOR_WEI = prev;
});
