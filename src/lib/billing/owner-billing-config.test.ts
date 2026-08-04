import assert from "node:assert/strict";
import test from "node:test";
import { eq, inArray } from "drizzle-orm";

import { db } from "@/db/index";
import { ownerBillingConfig, users } from "@/db/schema";
import {
  getOwnerBillingOverrides,
  mergeOwnerBilling,
  resolveOwnerBilling,
  resolveOwnerStarterIncludedUsdMicros,
  setOwnerBillingOverrides,
} from "@/lib/billing/owner-billing-config";
import {
  isOwnerStarterPlanKey,
  ownerStarterPlanKeyForAmount,
} from "@/lib/openmeter/owner-starter-key";
import { test as dbTest } from "@/test-utils/db-guard";
import { createTestUser } from "@/test-utils/fixtures";

const DEFAULTS = {
  starterIncludedUsdMicros: "5000000",
  endUserCap: 25,
};

test("no override row means platform defaults", () => {
  const resolved = mergeOwnerBilling(null, DEFAULTS);
  assert.equal(resolved.starterIncludedUsdMicros, "5000000");
  assert.equal(resolved.endUserCap, 25);
  assert.equal(resolved.hasOverride, false);
});

test("an override wins over the platform default", () => {
  const resolved = mergeOwnerBilling(
    {
      starterIncludedUsdMicros: "50000000",
      endUserCap: null,
      note: "design partner",
    },
    DEFAULTS,
  );
  assert.equal(resolved.starterIncludedUsdMicros, "50000000");
  // Unset fields still fall back.
  assert.equal(resolved.endUserCap, 25);
  assert.equal(resolved.hasOverride, true);
  assert.equal(resolved.note, "design partner");
});

test("malformed override amounts fall back rather than corrupt billing", () => {
  const resolved = mergeOwnerBilling(
    { starterIncludedUsdMicros: "not-micros", endUserCap: 0, note: null },
    DEFAULTS,
  );
  assert.equal(resolved.starterIncludedUsdMicros, "5000000");
  assert.equal(resolved.endUserCap, 25, "a cap of 0 would block all provisioning");
  assert.equal(resolved.hasOverride, false);
});

test("the platform-default amount maps to the shared plan key", () => {
  assert.equal(ownerStarterPlanKeyForAmount("5000000"), "pymthouse_owner_starter");
});

test("an override amount gets its own plan key, shared by amount", () => {
  const a = ownerStarterPlanKeyForAmount("50000000");
  const b = ownerStarterPlanKeyForAmount("50000000");
  assert.equal(a, "pymthouse_owner_starter_50000000");
  // Two owners on the same allowance share one plan — plan count is bounded by
  // distinct amounts, not by developer count.
  assert.equal(a, b);
  assert.notEqual(a, ownerStarterPlanKeyForAmount("25000000"));
});

test("a malformed amount falls back to the shared plan key", () => {
  assert.equal(ownerStarterPlanKeyForAmount("abc"), "pymthouse_owner_starter");
  assert.equal(ownerStarterPlanKeyForAmount(""), "pymthouse_owner_starter");
});

test("per-amount variants still classify as Owner Starter plans", () => {
  // Callers classify plans with this predicate; if a variant did not match, an
  // overridden owner would look unsubscribed.
  assert.equal(isOwnerStarterPlanKey("pymthouse_owner_starter"), true);
  assert.equal(isOwnerStarterPlanKey("pymthouse_owner_starter_50000000"), true);
  assert.equal(isOwnerStarterPlanKey("PYMTHOUSE_OWNER_STARTER_50000000"), true);
});

test("unrelated plan keys are not mistaken for Owner Starter", () => {
  assert.equal(isOwnerStarterPlanKey("pymthouse_owner_starter_extra"), false);
  assert.equal(isOwnerStarterPlanKey("some_app_plan"), false);
  assert.equal(isOwnerStarterPlanKey(null), false);
});

test("isOwnerStarterPlanKey does not treat the base key as a RegExp", () => {
  // Suffix must be digits only; a metacharacter-looking suffix is not a variant.
  assert.equal(isOwnerStarterPlanKey("pymthouse_owner_starter_[0-9]+"), false);
});

dbTest("getOwnerBillingOverrides returns null without a row", async (t) => {
  const ownerId = await createTestUser();
  t.after(async () => {
    await db.delete(users).where(eq(users.id, ownerId));
  });

  const overrides = await getOwnerBillingOverrides(ownerId);
  assert.equal(overrides, null);
});

dbTest("setOwnerBillingOverrides upserts and resolveOwnerBilling merges", async (t) => {
  const ownerId = await createTestUser();
  const adminId = await createTestUser({ role: "admin" });
  const userIds = [ownerId, adminId];

  t.after(async () => {
    await db
      .delete(ownerBillingConfig)
      .where(inArray(ownerBillingConfig.ownerUserId, userIds));
    await db.delete(users).where(inArray(users.id, userIds));
  });

  await setOwnerBillingOverrides({
    ownerUserId: ownerId,
    starterIncludedUsdMicros: "15000000",
    endUserCap: 50,
    note: "test override",
    updatedBy: adminId,
  });

  const overrides = await getOwnerBillingOverrides(ownerId);
  assert.deepEqual(overrides, {
    starterIncludedUsdMicros: "15000000",
    endUserCap: 50,
    note: "test override",
  });

  const resolved = await resolveOwnerBilling(ownerId);
  assert.equal(resolved.starterIncludedUsdMicros, "15000000");
  assert.equal(resolved.endUserCap, 50);
  assert.equal(resolved.hasOverride, true);
  assert.equal(resolved.note, "test override");

  const starterMicros = await resolveOwnerStarterIncludedUsdMicros(ownerId);
  assert.equal(starterMicros, "15000000");
});

dbTest("setOwnerBillingOverrides clears fields with explicit null", async (t) => {
  const ownerId = await createTestUser();
  const adminId = await createTestUser({ role: "admin" });
  const userIds = [ownerId, adminId];

  t.after(async () => {
    await db
      .delete(ownerBillingConfig)
      .where(inArray(ownerBillingConfig.ownerUserId, userIds));
    await db.delete(users).where(inArray(users.id, userIds));
  });

  await setOwnerBillingOverrides({
    ownerUserId: ownerId,
    starterIncludedUsdMicros: "20000000",
    updatedBy: adminId,
  });
  await setOwnerBillingOverrides({
    ownerUserId: ownerId,
    starterIncludedUsdMicros: null,
    updatedBy: adminId,
  });

  const overrides = await getOwnerBillingOverrides(ownerId);
  assert.equal(overrides?.starterIncludedUsdMicros, null);

  const resolved = await resolveOwnerBilling(ownerId);
  assert.equal(resolved.hasOverride, false);
});
