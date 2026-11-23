import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { prepaidCreditBlocksReassign } from "@/lib/admin-reassign-app-owner";

describe("prepaidCreditBlocksReassign", () => {
  it("allows reassign when Konnect credits are disabled", () => {
    assert.equal(prepaidCreditBlocksReassign({ status: "disabled" }), null);
  });

  it("allows reassign when the prepaid ledger is empty", () => {
    assert.equal(prepaidCreditBlocksReassign({ status: "empty" }), null);
  });

  it("blocks reassign when the owner has prepaid credits", () => {
    const result = prepaidCreditBlocksReassign({
      status: "credited",
      balance: {
        hasAccess: true,
        balanceUsdMicros: "5000000",
        lifetimeGrantedUsdMicros: "5000000",
        consumedUsdMicros: "0",
      },
    });
    assert.equal(result?.ok, false);
    if (result && !result.ok) {
      assert.equal(result.status, 400);
    }
  });

  it("fails closed when prepaid credit lookup errors", () => {
    const result = prepaidCreditBlocksReassign({
      status: "error",
      message: "Konnect credits/balance failed",
    });
    assert.equal(result?.ok, false);
    if (result && !result.ok) {
      assert.equal(result.status, 503);
    }
  });
});
