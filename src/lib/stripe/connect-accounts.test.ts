import test from "node:test";
import assert from "node:assert/strict";
import { applicationFeeAmountCents } from "./connect-accounts";

test("applicationFeeAmountCents computes bps fee", () => {
  assert.equal(
    applicationFeeAmountCents({ amountCents: 10_000, applicationFeeBps: 250 }),
    250,
  );
  assert.equal(
    applicationFeeAmountCents({ amountCents: 99, applicationFeeBps: 100 }),
    0,
  );
  assert.equal(
    applicationFeeAmountCents({ amountCents: 1000, applicationFeeBps: 0 }),
    0,
  );
});
