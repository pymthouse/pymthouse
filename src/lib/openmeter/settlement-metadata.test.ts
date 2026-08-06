import test from "node:test";
import assert from "node:assert/strict";
import {
  SETTLEMENT_CHARGE_MODEL_KEY,
  SETTLEMENT_CONNECT_ACCOUNT_KEY,
  merchantSettlementMetadata,
} from "./settlement-metadata";

test("settlement metadata keys match settlement defaults", () => {
  assert.equal(SETTLEMENT_CHARGE_MODEL_KEY, "stripe_charge_model");
  assert.equal(SETTLEMENT_CONNECT_ACCOUNT_KEY, "stripe_connect_account_id");
});

test("merchantSettlementMetadata stamps charge model and account", () => {
  assert.deepEqual(
    merchantSettlementMetadata({
      connectedAccountId: " acct_123 ",
      chargeModel: "direct",
    }),
    {
      stripe_charge_model: "direct",
      stripe_connect_account_id: "acct_123",
    },
  );
});

test("merchantSettlementMetadata rejects empty account", () => {
  assert.throws(
    () =>
      merchantSettlementMetadata({
        connectedAccountId: "   ",
        chargeModel: "destination",
      }),
    /connectedAccountId is required/,
  );
});
