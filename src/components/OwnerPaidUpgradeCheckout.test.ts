import assert from "node:assert/strict";
import test from "node:test";

import {
  confirmBlockingHint,
  confirmButtonLabel,
  isPaidPlanSelectionReady,
} from "@/components/OwnerPaidUpgradeCheckout";

test("isPaidPlanSelectionReady rejects the current paid tier", () => {
  assert.equal(isPaidPlanSelectionReady("owner-paid-producer", "owner-paid-producer"), false);
  assert.equal(isPaidPlanSelectionReady("owner-paid-studio", "owner-paid-producer"), true);
  assert.equal(isPaidPlanSelectionReady(null, "owner-paid-producer"), false);
  assert.equal(isPaidPlanSelectionReady("owner-paid-producer", null), true);
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

test("confirmBlockingHint tells users to pick a different plan", () => {
  assert.equal(
    confirmBlockingHint(false, true, true),
    "Select a different plan to continue.",
  );
});
