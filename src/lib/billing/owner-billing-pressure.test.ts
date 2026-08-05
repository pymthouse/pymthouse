import assert from "node:assert/strict";
import test from "node:test";

import {
  ownerSpendableRemainingUsdMicros,
  resolveOwnerBillingPressure,
} from "@/lib/billing/owner-billing-pressure";

test("chargeable whenever a payment method is on file", () => {
  assert.equal(
    resolveOwnerBillingPressure({
      hasPaymentMethod: true,
      creditBalanceUsdMicros: "0",
      subscriptions: [
        {
          appPublicClientId: null,
          discountUsdMicros: "5000000",
          usedUsdMicros: "5000000",
        },
      ],
    }),
    "chargeable",
  );
});

test("chargeable when chargeability is true even if listed methods are empty", () => {
  // Callers OR listed methods with hasChargeableBillingMethod before passing
  // hasPaymentMethod — pressure itself only sees the boolean.
  assert.equal(
    resolveOwnerBillingPressure({
      hasPaymentMethod: true,
      creditBalanceUsdMicros: "0",
      subscriptions: [
        {
          appPublicClientId: null,
          discountUsdMicros: "5000000",
          usedUsdMicros: "5000000",
        },
      ],
    }),
    "chargeable",
  );
});

test("solvent while plan allowance remains", () => {
  assert.equal(
    resolveOwnerBillingPressure({
      hasPaymentMethod: false,
      creditBalanceUsdMicros: "0",
      subscriptions: [
        {
          appPublicClientId: null,
          discountUsdMicros: "5000000",
          usedUsdMicros: "1000000",
        },
      ],
    }),
    "solvent",
  );
});

test("solvent while prepaid credits remain after allowance is gone", () => {
  assert.equal(
    resolveOwnerBillingPressure({
      hasPaymentMethod: false,
      creditBalanceUsdMicros: "2500000",
      subscriptions: [
        {
          appPublicClientId: null,
          discountUsdMicros: "5000000",
          usedUsdMicros: "5000000",
        },
      ],
    }),
    "solvent",
  );
});

test("blocked when allowance and credits are exhausted without a card", () => {
  assert.equal(
    resolveOwnerBillingPressure({
      hasPaymentMethod: false,
      creditBalanceUsdMicros: "0",
      subscriptions: [
        {
          appPublicClientId: null,
          discountUsdMicros: "5000000",
          usedUsdMicros: "5000000",
        },
      ],
    }),
    "blocked",
  );
});

test("solvent when there is no subscription yet (empty-state soft CTA)", () => {
  assert.equal(
    resolveOwnerBillingPressure({
      hasPaymentMethod: false,
      creditBalanceUsdMicros: "0",
      subscriptions: [],
    }),
    "solvent",
  );
});

test("spendable uses the shared owner-wallet subscription, not app rows", () => {
  const remaining = ownerSpendableRemainingUsdMicros({
    creditBalanceUsdMicros: "0",
    subscriptions: [
      {
        appPublicClientId: "app_other",
        discountUsdMicros: "99000000",
        usedUsdMicros: "0",
      },
      {
        appPublicClientId: null,
        discountUsdMicros: "5000000",
        usedUsdMicros: "4000000",
      },
    ],
  });
  assert.equal(remaining.toString(), "1000000");
});
