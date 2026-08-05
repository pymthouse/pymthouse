import assert from "node:assert/strict";
import test from "node:test";

import {
  billingCreditsEmptyHint,
  billingIntroCopy,
} from "@/lib/billing/owner-billing-copy";

test("billingIntroCopy on Paid does not mention Sandbox Starter", () => {
  const copy = billingIntroCopy({
    pressure: "solvent",
    starterPlanName: "Owner Sandbox Starter",
    onPaidPlan: true,
    currentPlanName: "Producer",
  });
  assert.match(copy, /Producer/);
  assert.doesNotMatch(copy, /Sandbox Starter|Upgrade to a paid plan/i);
});

test("billingIntroCopy on Starter still mentions starter plan and Upgrade", () => {
  const copy = billingIntroCopy({
    pressure: "solvent",
    starterPlanName: "Owner Sandbox Starter",
    onPaidPlan: false,
  });
  assert.match(copy, /Owner Sandbox Starter/);
  assert.match(copy, /Upgrade/);
});

test("billingCreditsEmptyHint distinguishes Paid vs Starter", () => {
  const paid = billingCreditsEmptyHint({
    onPaidPlan: true,
    currentPlanName: "Producer",
  });
  assert.match(paid, /Producer/);
  assert.doesNotMatch(paid, /Upgrade to a paid plan/);

  const starter = billingCreditsEmptyHint({ onPaidPlan: false });
  assert.match(starter, /Starter included usage/);
  assert.match(starter, /Upgrade to a paid plan/);
});
