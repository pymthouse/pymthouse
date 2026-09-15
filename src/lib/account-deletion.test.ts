import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  canPurgeAccountRow,
  creditTextFromBalance,
  fundedOwnerBlocksReassign,
  ownerHasPrepaidCredits,
} from "@/lib/account-deletion";

describe("ownerHasPrepaidCredits", () => {
  it("is false when there is no wallet", () => {
    assert.equal(ownerHasPrepaidCredits(null), false);
  });

  it("is true when remaining prepaid is above zero", () => {
    assert.equal(
      ownerHasPrepaidCredits({
        hasAccess: true,
        balanceUsdMicros: "159190000",
      }),
      true,
    );
  });
});

describe("creditTextFromBalance", () => {
  it("formats micros as dollars", () => {
    assert.equal(
      creditTextFromBalance({ balanceUsdMicros: "159190000" }),
      "$159.19",
    );
  });
});

describe("canPurgeAccountRow", () => {
  it("allows purge only when the row owns no apps", () => {
    assert.equal(canPurgeAccountRow(false), true);
    assert.equal(canPurgeAccountRow(true), false);
  });
});

describe("fundedOwnerBlocksReassign", () => {
  it("blocks moving an app off a credited owner", () => {
    assert.equal(fundedOwnerBlocksReassign(true), true);
    assert.equal(fundedOwnerBlocksReassign(false), false);
  });
});
