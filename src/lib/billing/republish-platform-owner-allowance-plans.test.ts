import assert from "node:assert/strict";
import test from "node:test";
import { inArray } from "drizzle-orm";

import { db } from "@/db/index";
import { ownerBillingConfig, users } from "@/db/schema";
import {
  classifyBaseOwnerStarterMigrateCandidate,
  hasStarterAllowanceOverride,
  listOwnersOnPlatformDefaultStarter,
  ownerPaidForceSyncWarning,
} from "@/lib/billing/republish-platform-owner-allowance-plans";
import { test as dbTest } from "@/test-utils/db-guard";
import { createTestUser } from "@/test-utils/fixtures";
import { setOwnerBillingOverrides } from "@/lib/billing/owner-billing-config";

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

test("ownerPaidForceSyncWarning is non-fatal and carries the failure code", () => {
  const warning = ownerPaidForceSyncWarning(new Error("konnect down"));
  assert.equal(warning.code, "owner_paid_force_sync_failed");
  assert.match(warning.message, /konnect down/);
  assert.match(warning.message, /self-heal/);
});

dbTest("listOwnersOnPlatformDefaultStarter excludes owners with starter override", async (t) => {
  const defaultOwnerId = await createTestUser({ role: "developer" });
  const overriddenOwnerId = await createTestUser({ role: "developer" });
  const adminId = await createTestUser({ role: "admin" });
  const userIds = [defaultOwnerId, overriddenOwnerId, adminId];

  t.after(async () => {
    await db
      .delete(ownerBillingConfig)
      .where(inArray(ownerBillingConfig.ownerUserId, userIds));
    await db.delete(users).where(inArray(users.id, userIds));
  });

  await setOwnerBillingOverrides({
    ownerUserId: overriddenOwnerId,
    starterIncludedUsdMicros: "50000000",
    updatedBy: adminId,
  });

  const owners = await listOwnersOnPlatformDefaultStarter();
  assert.ok(owners.includes(defaultOwnerId));
  assert.ok(owners.includes(adminId));
  assert.ok(!owners.includes(overriddenOwnerId));
});
