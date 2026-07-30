import assert from "node:assert/strict";
import { test } from "node:test";

import {
  applyWalletClassification,
  balanceFieldsFromSpendable,
  computeWalletFeeRollups,
  enrichByUserBalanceFields,
  isOwnerWalletExternalUserId,
  selectUsersForBalanceEnrichment,
  withWalletRollups,
  type EnrichableUserUsageRow,
} from "@/lib/billing-usage-balance-enrich";

test("isOwnerWalletExternalUserId matches bare, owner-wire, and compound keys", () => {
  const ownerId = "d3642304-31c5-43e9-9ed3-03eaad84964b";
  const clientId = "app_98575870d7ae33589a3f0660";

  assert.equal(isOwnerWalletExternalUserId(ownerId, ownerId, clientId), true);
  assert.equal(
    isOwnerWalletExternalUserId(ownerId, `owner:${ownerId}`, clientId),
    true,
  );
  assert.equal(
    isOwnerWalletExternalUserId(ownerId, `${clientId}:${ownerId}`, clientId),
    true,
  );
  assert.equal(
    isOwnerWalletExternalUserId(
      ownerId,
      `${clientId}:owner:${ownerId}`,
      clientId,
    ),
    true,
  );
  assert.equal(
    isOwnerWalletExternalUserId(
      ownerId,
      "a80a7b4e-8ea0-41e3-9ec3-5829656badff",
      clientId,
    ),
    false,
  );
});

test("computeWalletFeeRollups splits owner vs end-user fees", () => {
  const rollups = computeWalletFeeRollups([
    { networkFeeUsdMicros: "1000000", isOwnerWallet: true },
    { networkFeeUsdMicros: "5053259", isOwnerWallet: false },
    { networkFeeUsdMicros: "100", isOwnerWallet: false },
  ]);
  assert.equal(rollups.ownerNetworkFeeUsdMicros, "1000000");
  assert.equal(rollups.endUserNetworkFeeUsdMicros, "5053359");
});

test("selectUsersForBalanceEnrichment caps by fee and sets truncated", () => {
  const rows = Array.from({ length: 3 }, (_, i) => ({
    endUserId: `u${i}`,
    externalUserId: `u${i}`,
    userLabel: `u${i}`,
    networkFeeUsdMicros: String((i + 1) * 1000),
  }));
  const { selected, truncated } = selectUsersForBalanceEnrichment(rows, 2);
  assert.equal(truncated, true);
  assert.equal(selected.length, 2);
  assert.equal(selected[0]?.externalUserId, "u2");
  assert.equal(selected[1]?.externalUserId, "u1");
});

test("balanceFieldsFromSpendable derives consumed from granted − remaining", () => {
  const fields = balanceFieldsFromSpendable({
    spendableUsdMicros: "9950000",
    grantedUsdMicros: "5000000",
    remainingPlanDiscountUsdMicros: "0",
  });
  assert.equal(fields.spendableUsdMicros, "9950000");
  assert.equal(fields.planGrantedUsdMicros, "5000000");
  assert.equal(fields.planRemainingUsdMicros, "0");
  assert.equal(fields.planConsumedUsdMicros, "5000000");
});

test("applyWalletClassification labels owner row as You", () => {
  const ownerId = "owner-uuid";
  const clientId = "app_abc";
  const rows: EnrichableUserUsageRow[] = [
    {
      endUserId: ownerId,
      externalUserId: ownerId,
      userLabel: ownerId,
      networkFeeUsdMicros: "1",
    },
    {
      endUserId: "end-user",
      externalUserId: "end-user",
      userLabel: "end-user",
      networkFeeUsdMicros: "2",
    },
  ];
  const classified = applyWalletClassification(rows, ownerId, clientId);
  assert.equal(classified[0]?.isOwnerWallet, true);
  assert.equal(classified[0]?.userLabel, "You");
  assert.equal(classified[1]?.isOwnerWallet, false);
  assert.equal(classified[1]?.userLabel, "end-user");
});

test("enrichByUserBalanceFields attaches spendable and fails open", async () => {
  const rows: EnrichableUserUsageRow[] = [
    {
      endUserId: "u1",
      externalUserId: "u1",
      userLabel: "u1",
      networkFeeUsdMicros: "5000",
    },
    {
      endUserId: "u2",
      externalUserId: "u2",
      userLabel: "u2",
      networkFeeUsdMicros: "100",
    },
  ];
  const { byUser, balancesTruncated } = await enrichByUserBalanceFields({
    publicClientId: "app_test",
    byUser: rows,
    lookupSpendable: async (id) => {
      if (id === "u2") {
        throw new Error("boom");
      }
      return {
        spendableUsdMicros: "9000000",
        grantedUsdMicros: "5000000",
        remainingPlanDiscountUsdMicros: "1000000",
      };
    },
  });

  assert.equal(balancesTruncated, false);
  assert.equal(byUser[0]?.spendableUsdMicros, "9000000");
  assert.equal(byUser[0]?.planRemainingUsdMicros, "1000000");
  assert.equal(byUser[1]?.spendableUsdMicros, null);
  assert.equal(byUser[1]?.planRemainingUsdMicros, null);
});

test("withWalletRollups fills defaults for empty byUser", () => {
  const summary = withWalletRollups({
    byUser: [] as EnrichableUserUsageRow[],
  });
  assert.equal(summary.endUserNetworkFeeUsdMicros, "0");
  assert.equal(summary.ownerNetworkFeeUsdMicros, "0");
  assert.equal(summary.endUserCreditAllowance, null);
  assert.equal(summary.balancesTruncated, false);
});
