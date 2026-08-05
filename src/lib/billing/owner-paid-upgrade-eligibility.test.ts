import assert from "node:assert/strict";
import test from "node:test";

import { ownerEligibleForPaidUpgrade } from "./owner-paid-upgrade-eligibility";

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
