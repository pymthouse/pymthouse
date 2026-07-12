import assert from "node:assert/strict";
import test from "node:test";
import {
  effectiveBalanceUsdMicrosForGate,
  mintAllowanceGateDecision,
} from "./allowance-access";

test("mintAllowanceGateDecision blocks starter with zero remaining", () => {
  assert.deepEqual(
    mintAllowanceGateDecision(
      {
        allowance: {
          hasAccess: false,
          balanceUsdMicros: "0",
          consumedUsdMicros: "5000000",
          lifetimeGrantedUsdMicros: "5000000",
        },
        hasPaidSubscription: false,
        hasPlanIncludedAccess: false,
      },
      true,
    ),
    {
      code: "trial_credits_exhausted",
      message: "Starter included usage exhausted",
    },
  );
});

test("effectiveBalanceUsdMicrosForGate returns sentinel for paid and plan-included access", () => {
  assert.equal(
    effectiveBalanceUsdMicrosForGate({
      allowance: {
        hasAccess: false,
        balanceUsdMicros: "0",
        consumedUsdMicros: "0",
        lifetimeGrantedUsdMicros: "0",
      },
      hasPaidSubscription: true,
      hasPlanIncludedAccess: false,
    }),
    "1",
  );
  assert.equal(
    effectiveBalanceUsdMicrosForGate({
      allowance: {
        hasAccess: false,
        balanceUsdMicros: "0",
        consumedUsdMicros: "0",
        lifetimeGrantedUsdMicros: "0",
      },
      hasPaidSubscription: false,
      hasPlanIncludedAccess: true,
    }),
    "1",
  );
  assert.equal(
    effectiveBalanceUsdMicrosForGate({
      allowance: {
        hasAccess: true,
        balanceUsdMicros: "42",
        consumedUsdMicros: "0",
        lifetimeGrantedUsdMicros: "42",
      },
      hasPaidSubscription: false,
      hasPlanIncludedAccess: false,
    }),
    "42",
  );
  assert.equal(
    effectiveBalanceUsdMicrosForGate({
      allowance: null,
      hasPaidSubscription: false,
      hasPlanIncludedAccess: false,
    }),
    null,
  );
});
