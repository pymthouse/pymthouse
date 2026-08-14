import assert from "node:assert/strict";
import { test } from "node:test";

import { resolveEndUserMigratePolicy } from "./end-user-migrate-policy";

test("--full merchant: transfer to eu_, cancel legacy, provision Starter", () => {
  assert.deepEqual(
    resolveEndUserMigratePolicy({
      billingMode: "merchant",
      full: true,
      transferBalances: false,
      cancelLegacy: false,
      provisionMerchant: false,
    }),
    {
      transferTarget: "eu",
      cancelLegacy: true,
      provisionMerchantStarter: true,
    },
  );
});

test("--full owner_rollup: transfer to owner wallet, cancel legacy, no Starter", () => {
  assert.deepEqual(
    resolveEndUserMigratePolicy({
      billingMode: "owner_rollup",
      full: true,
      transferBalances: true,
      cancelLegacy: false,
      provisionMerchant: true,
    }),
    {
      transferTarget: "owner",
      cancelLegacy: true,
      provisionMerchantStarter: false,
    },
  );
});

test("granular merchant flags map to eu_ transfer", () => {
  assert.deepEqual(
    resolveEndUserMigratePolicy({
      billingMode: "merchant",
      full: false,
      transferBalances: true,
      cancelLegacy: true,
      provisionMerchant: true,
    }),
    {
      transferTarget: "eu",
      cancelLegacy: true,
      provisionMerchantStarter: true,
    },
  );
});

test("granular ensure-only leaves wallets untouched", () => {
  assert.deepEqual(
    resolveEndUserMigratePolicy({
      billingMode: "owner_rollup",
      full: false,
      transferBalances: false,
      cancelLegacy: false,
      provisionMerchant: false,
    }),
    {
      transferTarget: "none",
      cancelLegacy: false,
      provisionMerchantStarter: false,
    },
  );
});

test("owner_rollup + --transfer-balances without --full is rejected", () => {
  assert.throws(
    () =>
      resolveEndUserMigratePolicy({
        billingMode: "owner_rollup",
        full: false,
        transferBalances: true,
        cancelLegacy: true,
        provisionMerchant: false,
      }),
    /must not transfer legacy prepaid onto eu_/,
  );
});
