import assert from "node:assert/strict";
import test from "node:test";

import {
  OWNER_CHECKOUT_FREE_PLAN_KEY,
  confirmBlockingHint,
  confirmButtonLabel,
  isCheckoutFreePlanKey,
  isPaidPlanSelectionReady,
} from "@/components/OwnerPaidUpgradeCheckout";

test("isPaidPlanSelectionReady rejects the current paid tier", () => {
  assert.equal(isPaidPlanSelectionReady("owner-paid-producer", "owner-paid-producer"), false);
  assert.equal(isPaidPlanSelectionReady("owner-paid-studio", "owner-paid-producer"), true);
  assert.equal(isPaidPlanSelectionReady(null, "owner-paid-producer"), false);
  assert.equal(isPaidPlanSelectionReady("owner-paid-producer", null), true);
  assert.equal(
    isPaidPlanSelectionReady(OWNER_CHECKOUT_FREE_PLAN_KEY, "pymthouse_owner_paid_producer"),
    true,
  );
});

test("confirmButtonLabel uses change-mode copy", () => {
  assert.equal(confirmButtonLabel(false, null, "change"), "Confirm change");
  assert.equal(confirmButtonLabel(true, null, "change"), "Changing…");
  assert.equal(confirmButtonLabel(false, null, "upgrade"), "Confirm upgrade");
  assert.equal(
    confirmButtonLabel(false, "49", "change"),
    "Confirm — charge $49 today",
  );
});

test("confirmButtonLabel uses Free downgrade copy", () => {
  assert.equal(
    confirmButtonLabel(false, "0", "change", { downgradeToFree: true }),
    "Confirm — keep plan until cycle ends",
  );
  assert.equal(
    confirmButtonLabel(true, "0", "change", { downgradeToFree: true }),
    "Scheduling…",
  );
  assert.equal(isCheckoutFreePlanKey(OWNER_CHECKOUT_FREE_PLAN_KEY), true);
  assert.equal(isCheckoutFreePlanKey("pymthouse_owner_paid_producer"), false);
});

test("confirmBlockingHint tells users to pick a different plan", () => {
  assert.equal(
    confirmBlockingHint(false, true, true),
    "Select a different plan to continue.",
  );
});
