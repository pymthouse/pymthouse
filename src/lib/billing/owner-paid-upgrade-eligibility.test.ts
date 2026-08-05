import assert from "node:assert/strict";
import test from "node:test";

import {
  ownerCanAccessPlanCheckout,
  ownerCanChangePaidPlan,
  ownerCurrentPaidPlanKey,
  ownerEligibleForPaidUpgrade,
} from "./owner-paid-upgrade-eligibility";

test("ownerEligibleForPaidUpgrade is true with no subscriptions", () => {
  assert.equal(ownerEligibleForPaidUpgrade([]), true);
});

test("ownerEligibleForPaidUpgrade is true on Sandbox Starter", () => {
  assert.equal(
    ownerEligibleForPaidUpgrade([
      {
        openMeterPlanKey: "pymthouse_owner_starter",
        appPublicClientId: null,
      },
    ]),
    true,
  );
});

test("ownerEligibleForPaidUpgrade is false on Owner Paid", () => {
  assert.equal(
    ownerEligibleForPaidUpgrade([
      {
        openMeterPlanKey: "pymthouse_owner_paid",
        appPublicClientId: null,
      },
    ]),
    false,
  );
  assert.equal(
    ownerEligibleForPaidUpgrade([
      {
        openMeterPlanKey: "pymthouse_owner_paid_growth",
        appPublicClientId: null,
      },
    ]),
    false,
  );
  assert.equal(
    ownerEligibleForPaidUpgrade([
      {
        openMeterPlanKey: "pymthouse_owner_paid_producer",
        appPublicClientId: null,
      },
    ]),
    false,
  );
});

test("ownerEligibleForPaidUpgrade ignores app-scoped paid rows when wallet is Starter", () => {
  assert.equal(
    ownerEligibleForPaidUpgrade([
      {
        openMeterPlanKey: "pymthouse_owner_starter",
        appPublicClientId: null,
      },
      {
        openMeterPlanKey: "app_x:plan_paid",
        appPublicClientId: "app_x",
      },
    ]),
    true,
  );
});

test("ownerCurrentPaidPlanKey and change/access helpers", () => {
  assert.equal(ownerCurrentPaidPlanKey([]), null);
  assert.equal(ownerCanChangePaidPlan([]), false);
  assert.equal(ownerCanAccessPlanCheckout([]), true);

  const producer = [
    {
      openMeterPlanKey: "pymthouse_owner_paid_producer",
      appPublicClientId: null,
    },
  ];
  assert.equal(
    ownerCurrentPaidPlanKey(producer),
    "pymthouse_owner_paid_producer",
  );
  assert.equal(ownerCanChangePaidPlan(producer), true);
  assert.equal(ownerCanAccessPlanCheckout(producer), true);
  assert.equal(ownerEligibleForPaidUpgrade(producer), false);

  const starter = [
    {
      openMeterPlanKey: "pymthouse_owner_starter",
      appPublicClientId: null,
    },
  ];
  assert.equal(ownerCanChangePaidPlan(starter), false);
  assert.equal(ownerCanAccessPlanCheckout(starter), true);
});

test("ownerCanChangePaidPlan stays true while Paid is active with scheduled Starter", () => {
  const pendingDowngrade = [
    {
      openMeterPlanKey: "pymthouse_owner_paid_producer",
      appPublicClientId: null,
    },
    {
      openMeterPlanKey: "pymthouse_owner_starter",
      appPublicClientId: null,
    },
  ];
  assert.equal(ownerCanChangePaidPlan(pendingDowngrade), true);
  assert.equal(ownerEligibleForPaidUpgrade(pendingDowngrade), false);
  assert.equal(ownerCanAccessPlanCheckout(pendingDowngrade), true);
});
