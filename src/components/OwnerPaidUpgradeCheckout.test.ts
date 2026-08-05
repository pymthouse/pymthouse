import assert from "node:assert/strict";
import test from "node:test";

import {
  OWNER_CHECKOUT_FREE_PLAN_KEY,
  confirmBlockingHint,
  confirmButtonLabel,
  isCheckoutFreePlanKey,
  isPaidPlanSelectionReady,
  isResumePendingDowngradeSelection,
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

test("isResumePendingDowngradeSelection only when pending + current tier", () => {
  assert.equal(
    isResumePendingDowngradeSelection("pymthouse_owner_paid_producer", "pymthouse_owner_paid_producer", true),
    true,
  );
  assert.equal(
    isResumePendingDowngradeSelection("pymthouse_owner_paid_producer", "pymthouse_owner_paid_producer", false),
    false,
  );
  assert.equal(
    isResumePendingDowngradeSelection("pymthouse_owner_paid_studio", "pymthouse_owner_paid_producer", true),
    false,
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

test("confirmButtonLabel uses Resume copy for pending downgrade", () => {
  assert.equal(
    confirmButtonLabel(false, "2.50", "change", {
      resumePendingDowngrade: true,
      planName: "Producer",
    }),
    "Resume Producer — no charge today",
  );
  assert.equal(
    confirmButtonLabel(true, "2.50", "change", { resumePendingDowngrade: true }),
    "Resuming…",
  );
});

test("confirmBlockingHint clears when resume is available", () => {
  assert.equal(
    confirmBlockingHint(false, true, true, { resumePendingDowngrade: true }),
    "",
  );
  assert.equal(
    confirmBlockingHint(false, true, true),
    "Select a different plan to continue.",
  );
});
