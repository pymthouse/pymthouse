import assert from "node:assert/strict";
import test from "node:test";

import { pickEffectiveThresholdUsdMicros } from "@/lib/billing/effective-invoice-threshold";
import { decideAllowsOverageInvoicing } from "@/lib/billing/overage-invoicing";
import {
  gatheringInvoiceMeetsThreshold,
  gatheringTotalUsdMicros,
} from "@/lib/billing/threshold-invoice-worker";
import { mintAllowanceGateDecision } from "@/lib/oidc/mint-user-signer-token";

test("pickEffectiveThresholdUsdMicros prefers plan charge threshold", () => {
  assert.equal(
    pickEffectiveThresholdUsdMicros({
      planChargeThresholdUsdMicros: "5000000",
      appInvoiceThresholdUsdMicros: "10000000",
    }),
    5_000_000n,
  );
});

test("pickEffectiveThresholdUsdMicros falls back to app invoice threshold", () => {
  assert.equal(
    pickEffectiveThresholdUsdMicros({
      planChargeThresholdUsdMicros: null,
      appInvoiceThresholdUsdMicros: "2500000",
    }),
    2_500_000n,
  );
  assert.equal(
    pickEffectiveThresholdUsdMicros({
      planChargeThresholdUsdMicros: "0",
      appInvoiceThresholdUsdMicros: "1000000",
    }),
    1_000_000n,
  );
  assert.equal(
    pickEffectiveThresholdUsdMicros({
      planChargeThresholdUsdMicros: null,
      appInvoiceThresholdUsdMicros: null,
    }),
    null,
  );
});

test("decideAllowsOverageInvoicing: merchant + chargeable + usage plan → allow", () => {
  assert.equal(
    decideAllowsOverageInvoicing({
      isOwner: false,
      billingMode: "merchant",
      ownerAllowsOverage: false,
      merchantConnectReady: true,
      merchantChargeable: true,
      merchantHasOverageCapablePlan: true,
    }),
    true,
  );
});

test("decideAllowsOverageInvoicing: merchant no PM → deny", () => {
  assert.equal(
    decideAllowsOverageInvoicing({
      isOwner: false,
      billingMode: "merchant",
      ownerAllowsOverage: true,
      merchantConnectReady: true,
      merchantChargeable: false,
      merchantHasOverageCapablePlan: true,
    }),
    false,
  );
});

test("decideAllowsOverageInvoicing: merchant chargeability null fails closed", () => {
  assert.equal(
    decideAllowsOverageInvoicing({
      isOwner: false,
      billingMode: "merchant",
      ownerAllowsOverage: false,
      merchantConnectReady: true,
      merchantChargeable: null,
      merchantHasOverageCapablePlan: true,
    }),
    false,
  );
});

test("decideAllowsOverageInvoicing: merchant starter/free plan → deny", () => {
  assert.equal(
    decideAllowsOverageInvoicing({
      isOwner: false,
      billingMode: "merchant",
      ownerAllowsOverage: false,
      merchantConnectReady: true,
      merchantChargeable: true,
      merchantHasOverageCapablePlan: false,
    }),
    false,
  );
});

test("decideAllowsOverageInvoicing: rollup + owner Paid+PM → allow", () => {
  assert.equal(
    decideAllowsOverageInvoicing({
      isOwner: false,
      billingMode: "owner_rollup",
      ownerAllowsOverage: true,
      merchantConnectReady: false,
      merchantChargeable: false,
      merchantHasOverageCapablePlan: false,
    }),
    true,
  );
});

test("decideAllowsOverageInvoicing: rollup owner Starter → deny", () => {
  assert.equal(
    decideAllowsOverageInvoicing({
      isOwner: false,
      billingMode: "owner_rollup",
      ownerAllowsOverage: false,
      merchantConnectReady: true,
      merchantChargeable: true,
      merchantHasOverageCapablePlan: true,
    }),
    false,
  );
});

test("decideAllowsOverageInvoicing: owner identity uses owner predicate only", () => {
  assert.equal(
    decideAllowsOverageInvoicing({
      isOwner: true,
      billingMode: "merchant",
      ownerAllowsOverage: true,
      merchantConnectReady: false,
      merchantChargeable: false,
      merchantHasOverageCapablePlan: false,
    }),
    true,
  );
  assert.equal(
    decideAllowsOverageInvoicing({
      isOwner: true,
      billingMode: "merchant",
      ownerAllowsOverage: false,
      merchantConnectReady: true,
      merchantChargeable: true,
      merchantHasOverageCapablePlan: true,
    }),
    false,
  );
});

test("mintAllowanceGateDecision still denies zero spendable without overage", () => {
  assert.deepEqual(
    mintAllowanceGateDecision(
      {
        hasAccess: false,
        balanceUsdMicros: "0",
        consumedUsdMicros: "0",
        lifetimeGrantedUsdMicros: "0",
      },
      true,
      { allowsOverageInvoicing: false },
    ),
    {
      code: "trial_credits_exhausted",
      message: "Payment method required",
    },
  );
});

test("mintAllowanceGateDecision allows zero spendable with overage flag", () => {
  assert.equal(
    mintAllowanceGateDecision(
      {
        hasAccess: false,
        balanceUsdMicros: "0",
        consumedUsdMicros: "0",
        lifetimeGrantedUsdMicros: "0",
      },
      true,
      { allowsOverageInvoicing: true },
    ),
    null,
  );
});

test("gatheringTotalUsdMicros parses dollars and micros", () => {
  assert.equal(gatheringTotalUsdMicros("5.00"), 5_000_000n);
  assert.equal(gatheringTotalUsdMicros(1.5), 1_500_000n);
  // Integer strings longer than 8 digits are treated as micros already.
  assert.equal(gatheringTotalUsdMicros("100000000"), 100_000_000n);
  assert.equal(gatheringTotalUsdMicros(null), null);
  assert.equal(gatheringTotalUsdMicros(""), null);
});

test("gatheringInvoiceMeetsThreshold raises when accrued >= threshold", () => {
  const threshold = 5_000_000n;
  assert.equal(gatheringInvoiceMeetsThreshold(["4.99"], threshold), false);
  assert.equal(gatheringInvoiceMeetsThreshold(["5.00"], threshold), true);
  assert.equal(
    gatheringInvoiceMeetsThreshold(["1.00", "5000000"], threshold),
    true,
  );
  assert.equal(gatheringInvoiceMeetsThreshold([], threshold), false);
});
