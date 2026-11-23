import assert from "node:assert/strict";
import test from "node:test";

import {
  identityBillingPanelKey,
  identityPlanSelectValue,
} from "./identity-plan-selection";

test("identityPlanSelectValue follows the live plan for the current identity", () => {
  // Soft-nav A(Pro) → B(Starter): value must become Starter, not retain Pro.
  const onA = identityPlanSelectValue("plan_pro");
  assert.equal(onA, "plan_pro");
  const onB = identityPlanSelectValue("plan_starter");
  assert.equal(onB, "plan_starter");
  assert.notEqual(onB, onA);
});

test("identityPlanSelectValue clears when the identity has no live plan", () => {
  assert.equal(identityPlanSelectValue(""), "");
  assert.equal(identityPlanSelectValue(null), "");
  assert.equal(identityPlanSelectValue(undefined), "");
  assert.equal(identityPlanSelectValue("   "), "");
});

test("identityBillingPanelKey changes when externalUserId changes", () => {
  const app = "app_abc";
  assert.notEqual(
    identityBillingPanelKey(app, "user-a"),
    identityBillingPanelKey(app, "user-b"),
  );
  assert.equal(
    identityBillingPanelKey(app, "user-a"),
    identityBillingPanelKey(app, "user-a"),
  );
});
