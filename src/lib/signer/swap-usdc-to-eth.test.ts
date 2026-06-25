import test from "node:test";
import assert from "node:assert/strict";
import { estimateEthWeiFromUsdc } from "@/lib/signer/swap-usdc-to-eth";

test("estimateEthWeiFromUsdc converts 1 USDC at $3500 ETH", () => {
  const oneUsdc = 1_000_000n; // 1 USDC with 6 decimals
  const ethWei = estimateEthWeiFromUsdc(oneUsdc, 3500);
  const expected = 1_000_000_000_000_000_000n / 3500n;
  assert.equal(ethWei, expected);
});
