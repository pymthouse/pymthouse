import assert from "node:assert/strict";
import test from "node:test";

import {
  classifyBaseOwnerStarterMigrateCandidate,
  hasStarterAllowanceOverride,
} from "@/lib/billing/republish-base-owner-starter";

test("classifyBaseOwnerStarterMigrateCandidate skips target and non-base keys", () => {
  assert.equal(
    classifyBaseOwnerStarterMigrateCandidate({
      subscriptionPlanId: "plan_new",
      targetPlanId: "plan_new",
      planKey: "pymthouse_owner_starter",
    }),
    "skip_already_on_target",
  );
  assert.equal(
    classifyBaseOwnerStarterMigrateCandidate({
      subscriptionPlanId: "plan_old",
      targetPlanId: "plan_new",
      planKey: "pymthouse_owner_starter_50000000",
    }),
    "skip_not_base",
  );
  assert.equal(
    classifyBaseOwnerStarterMigrateCandidate({
      subscriptionPlanId: "plan_old",
      targetPlanId: "plan_new",
      planKey: "pymthouse_owner_starter",
    }),
    "migrate",
  );
});

test("hasStarterAllowanceOverride requires a digit micros string", () => {
  assert.equal(hasStarterAllowanceOverride(null), false);
  assert.equal(hasStarterAllowanceOverride(""), false);
  assert.equal(hasStarterAllowanceOverride("abc"), false);
  assert.equal(hasStarterAllowanceOverride("5000000"), true);
});
