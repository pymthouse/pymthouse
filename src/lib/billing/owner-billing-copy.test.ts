import assert from "node:assert/strict";
import test from "node:test";

import {
  billingCreditsEmptyHint,
  billingIntroCopy,
  planCheckoutBillingMethodOnFileHint,
  planCheckoutLinkBillingMethodCopy,
} from "@/lib/billing/owner-billing-copy";

test("billingIntroCopy on Paid does not mention Sandbox Starter", () => {
  const copy = billingIntroCopy({
    pressure: "solvent",
    starterPlanName: "Owner Sandbox Starter",
    onPaidPlan: true,
    currentPlanName: "Producer",
  });
  assert.match(copy, /Producer/);
  assert.match(copy, /payment method/);
  assert.doesNotMatch(copy, /Sandbox Starter|Upgrade to a paid plan/i);
});

test("billingIntroCopy on Paid chargeable mentions plan fee and overage", () => {
  const copy = billingIntroCopy({
    pressure: "chargeable",
    starterPlanName: "Owner Sandbox Starter",
    onPaidPlan: true,
    currentPlanName: "Producer",
  });
  assert.match(copy, /plan fee and overage/i);
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

test("billingIntroCopy on Starter chargeable points at Upgrade, not plan fees", () => {
  const copy = billingIntroCopy({
    pressure: "chargeable",
    starterPlanName: "Owner Sandbox Starter",
    onPaidPlan: false,
  });
  assert.match(copy, /Upgrade/i);
  assert.match(copy, /payment method is ready for a future Upgrade/i);
  assert.doesNotMatch(copy, /pays plan fees and overage/i);
});

test("billingCreditsEmptyHint distinguishes Paid vs Starter", () => {
  const paid = billingCreditsEmptyHint({
    onPaidPlan: true,
    currentPlanName: "Producer",
  });
  assert.match(paid, /Producer/);
  assert.match(paid, /payment method/);
  assert.doesNotMatch(paid, /Upgrade to a paid plan/);

  const starter = billingCreditsEmptyHint({
    onPaidPlan: false,
    starterPlanName: "Developer Free Tier",
  });
  assert.match(starter, /Developer Free Tier included usage/);
  assert.match(starter, /Upgrade to a paid plan/);
  assert.match(starter, /plan fee and overage/);

  const fallback = billingCreditsEmptyHint({ onPaidPlan: false });
  assert.match(fallback, /Starter included usage/);
});

test("planCheckoutLinkBillingMethodCopy frames Change as confirm this purchase", () => {
  const change = planCheckoutLinkBillingMethodCopy("change");
  assert.match(change.title, /payment method/i);
  assert.match(change.detail, /confirm this plan change/i);
  assert.match(change.detail, /renewals and overage/i);
  assert.match(change.button, /payment method/i);

  const upgrade = planCheckoutLinkBillingMethodCopy("upgrade");
  assert.match(upgrade.detail, /confirm this upgrade/i);
  assert.match(upgrade.detail, /plan fee and overage/i);
});

test("planCheckoutBillingMethodOnFileHint is plan fee + overage", () => {
  assert.equal(
    planCheckoutBillingMethodOnFileHint(),
    "Used for plan fee and overage.",
  );
});
