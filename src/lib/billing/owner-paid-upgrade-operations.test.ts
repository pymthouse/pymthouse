import assert from "node:assert/strict";
import test from "node:test";
import { eq } from "drizzle-orm";

import { db } from "@/db/index";
import { ownerPaidUpgradeOperations } from "@/db/schema";
import {
  claimOwnerPaidUpgradeOperation,
  completeOwnerPaidUpgradeOperation,
  failOwnerPaidUpgradeOperation,
  ownerPaidUpgradeIdempotencyKey,
} from "@/lib/billing/owner-paid-upgrade-operations";
import { test as dbTest } from "@/test-utils/db-guard";

test("ownerPaidUpgradeIdempotencyKey is owner+plan scoped", () => {
  assert.equal(
    ownerPaidUpgradeIdempotencyKey("user_1", "pymthouse_owner_paid"),
    "owner_paid_upgrade:user_1:pymthouse_owner_paid",
  );
  assert.equal(
    ownerPaidUpgradeIdempotencyKey(" user_1 ", " pymthouse_owner_paid "),
    "owner_paid_upgrade:user_1:pymthouse_owner_paid",
  );
});

dbTest("claimOwnerPaidUpgradeOperation returns completed result on retry", async (t) => {
  const ownerUserId = `owner_upg_${Date.now().toString(36)}`;
  const planKey = "pymthouse_owner_paid";

  const first = await claimOwnerPaidUpgradeOperation({ ownerUserId, planKey });
  assert.equal(first.action, "proceed");
  if (first.action !== "proceed") return;

  t.after(async () => {
    await db
      .delete(ownerPaidUpgradeOperations)
      .where(eq(ownerPaidUpgradeOperations.id, first.operationId));
  });

  const result = {
    openmeterSubscriptionId: "sub_1",
    planKey,
    openmeterPlanId: "plan_1",
    monthlyFeeUsd: "20.00",
    alreadyPaid: false,
  };
  await completeOwnerPaidUpgradeOperation({
    operationId: first.operationId,
    result,
  });

  const second = await claimOwnerPaidUpgradeOperation({ ownerUserId, planKey });
  assert.equal(second.action, "return");
  if (second.action === "return") {
    assert.deepEqual(second.result, result);
  }
});

dbTest("claimOwnerPaidUpgradeOperation rejects fresh in-progress", async (t) => {
  const ownerUserId = `owner_upg_ip_${Date.now().toString(36)}`;
  const planKey = "pymthouse_owner_paid_growth";

  const first = await claimOwnerPaidUpgradeOperation({ ownerUserId, planKey });
  assert.equal(first.action, "proceed");
  if (first.action !== "proceed") return;

  t.after(async () => {
    await db
      .delete(ownerPaidUpgradeOperations)
      .where(eq(ownerPaidUpgradeOperations.id, first.operationId));
  });

  const second = await claimOwnerPaidUpgradeOperation({ ownerUserId, planKey });
  assert.deepEqual(second, { action: "reject", reason: "in_progress" });
});

dbTest("failed upgrade operation can be reclaimed", async (t) => {
  const ownerUserId = `owner_upg_fail_${Date.now().toString(36)}`;
  const planKey = "pymthouse_owner_paid";

  const first = await claimOwnerPaidUpgradeOperation({ ownerUserId, planKey });
  assert.equal(first.action, "proceed");
  if (first.action !== "proceed") return;

  t.after(async () => {
    await db
      .delete(ownerPaidUpgradeOperations)
      .where(eq(ownerPaidUpgradeOperations.ownerUserId, ownerUserId));
  });

  await failOwnerPaidUpgradeOperation({
    operationId: first.operationId,
    error: "konnect down",
  });

  const second = await claimOwnerPaidUpgradeOperation({ ownerUserId, planKey });
  assert.equal(second.action, "proceed");
  if (second.action === "proceed") {
    assert.equal(second.operationId, first.operationId);
  }
});
