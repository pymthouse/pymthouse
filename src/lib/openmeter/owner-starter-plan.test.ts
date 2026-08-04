import assert from "node:assert/strict";
import test from "node:test";

import {
  ensureOwnerStarterPlanSynced,
  ensureOwnerStarterSubscription,
  forceSyncOwnerStarterPlan,
  invalidateOwnerStarterPlanCache,
  resetOwnerStarterPlanCacheForTests,
} from "@/lib/openmeter/owner-starter-plan";
import { OWNER_STARTER_PLAN_KEY } from "@/lib/openmeter/owner-starter-key";
import { test as dbTest } from "@/test-utils/db-guard";

test("ensureOwnerStarterSubscription returns empty when OpenMeter is unavailable", async () => {
  // NODE_ENV=test without OPENMETER_TEST_LIVE → admin client unavailable.
  resetOwnerStarterPlanCacheForTests();
  invalidateOwnerStarterPlanCache();
  const result = await ensureOwnerStarterSubscription({
    ownerUserId: "user_test_owner",
  });
  assert.equal(result.openmeterSubscriptionId, null);
  assert.equal(result.planKey, OWNER_STARTER_PLAN_KEY);
  assert.equal(result.openmeterPlanId, "");
  assert.equal(result.created, false);
});

dbTest("ensureOwnerStarterPlanSynced rejects when OpenMeter is unavailable", async () => {
  resetOwnerStarterPlanCacheForTests();
  await assert.rejects(
    () => ensureOwnerStarterPlanSynced("5000000"),
    /OpenMeter is not configured/,
  );
});

test("forceSyncOwnerStarterPlan rejects when OpenMeter is unavailable", async () => {
  resetOwnerStarterPlanCacheForTests();
  await assert.rejects(
    () => forceSyncOwnerStarterPlan("5000000"),
    /OpenMeter is not configured/,
  );
});
