import assert from "node:assert/strict";
import test from "node:test";

import { eq } from "drizzle-orm";

import { db } from "@/db/index";
import { ownerSubscriptionTiers } from "@/db/schema";
import {
  createOwnerSubscriptionTier,
  getOwnerSubscriptionTierByKey,
  markOwnerSubscriptionTierSynced,
  parseOwnerTierIncludedMicros,
  parseOwnerTierMonthlyFeeUsd,
  parseOwnerTierOverageRateUsd,
  resolveOwnerTierOverageRateUsd,
  toOwnerSubscriptionTierPublic,
  updateOwnerSubscriptionTier,
} from "@/lib/billing/owner-subscription-tiers";
import { defaultRetailRateUsd } from "@/lib/plan-pricing";
import {
  isValidOwnerPaidTierKey,
  OWNER_PAID_PLAN_KEY,
} from "@/lib/openmeter/owner-paid-key";
import { test as dbTest } from "@/test-utils/db-guard";

test("parseOwnerTierMonthlyFeeUsd accepts positive decimals", () => {
  assert.equal(parseOwnerTierMonthlyFeeUsd("20"), "20.00");
  assert.equal(parseOwnerTierMonthlyFeeUsd("20.5"), "20.50");
  assert.equal(parseOwnerTierMonthlyFeeUsd(29), "29.00");
  assert.equal(parseOwnerTierMonthlyFeeUsd("0"), null);
  assert.equal(parseOwnerTierMonthlyFeeUsd("-1"), null);
  assert.equal(parseOwnerTierMonthlyFeeUsd("nope"), null);
  assert.equal(parseOwnerTierMonthlyFeeUsd(""), null);
});

test("parseOwnerTierIncludedMicros accepts non-negative integers", () => {
  assert.equal(parseOwnerTierIncludedMicros("5000000"), "5000000");
  assert.equal(parseOwnerTierIncludedMicros(0), "0");
  assert.equal(parseOwnerTierIncludedMicros("0"), "0");
  assert.equal(parseOwnerTierIncludedMicros(1.9), "1");
  assert.equal(parseOwnerTierIncludedMicros("-1"), null);
  assert.equal(parseOwnerTierIncludedMicros("1.5"), null);
  assert.equal(parseOwnerTierIncludedMicros("abc"), null);
});

test("parseOwnerTierOverageRateUsd rejects invalid rates", () => {
  assert.deepEqual(parseOwnerTierOverageRateUsd(null), {
    ok: true,
    value: null,
  });
  assert.deepEqual(parseOwnerTierOverageRateUsd(""), {
    ok: true,
    value: null,
  });
  assert.deepEqual(parseOwnerTierOverageRateUsd("0.000001"), {
    ok: true,
    value: "0.000001",
  });
  assert.equal(parseOwnerTierOverageRateUsd("0").ok, false);
  assert.equal(parseOwnerTierOverageRateUsd("-1").ok, false);
  assert.equal(parseOwnerTierOverageRateUsd("nope").ok, false);
  assert.equal(parseOwnerTierOverageRateUsd(0).ok, false);
});

test("resolveOwnerTierOverageRateUsd falls back to retail default", () => {
  assert.equal(resolveOwnerTierOverageRateUsd(null), defaultRetailRateUsd());
  assert.equal(resolveOwnerTierOverageRateUsd("0"), defaultRetailRateUsd());
  assert.equal(resolveOwnerTierOverageRateUsd("0.000002"), "0.000002");
});

test("isValidOwnerPaidTierKey allows base, slug, and configured key", () => {
  assert.equal(isValidOwnerPaidTierKey("pymthouse_owner_paid"), true);
  assert.equal(isValidOwnerPaidTierKey("pymthouse_owner_paid_growth"), true);
  assert.equal(isValidOwnerPaidTierKey("pymthouse_owner_paid_pro_plus"), true);
  assert.equal(isValidOwnerPaidTierKey(OWNER_PAID_PLAN_KEY), true);
  assert.equal(isValidOwnerPaidTierKey("pymthouse_owner_starter"), false);
  assert.equal(isValidOwnerPaidTierKey("owner_paid"), false);
});

test("toOwnerSubscriptionTierPublic maps active flag", () => {
  const now = new Date().toISOString();
  const pub = toOwnerSubscriptionTierPublic({
    id: "t1",
    key: "pymthouse_owner_paid",
    name: "Owner Paid",
    description: null,
    monthlyFeeUsd: "20.00",
    includedUsdMicros: "5000000",
    overageRateUsd: null,
    sortOrder: 0,
    active: 1,
    openmeterPlanId: "plan_1",
    openmeterPlanVersion: 2,
    lastSyncedAt: now,
    createdAt: now,
    updatedAt: now,
  });
  assert.equal(pub.active, true);
  assert.equal(pub.openmeterPlanId, "plan_1");
  assert.equal(pub.monthlyFeeUsd, "20.00");
});

dbTest("create/update owner subscription tiers and reject bad overage", async (t) => {
  const key = `pymthouse_owner_paid_cov_${Date.now().toString(36)}`;
  const created = await createOwnerSubscriptionTier({
    key,
    name: "Coverage Tier",
    monthlyFeeUsd: "15",
    includedUsdMicros: "2500000",
    overageRateUsd: "0.000003",
    sortOrder: 3,
    active: true,
  });
  t.after(async () => {
    await db
      .delete(ownerSubscriptionTiers)
      .where(eq(ownerSubscriptionTiers.id, created.id));
  });

  assert.equal(created.monthlyFeeUsd, "15.00");
  assert.equal(created.overageRateUsd, "0.000003");

  await assert.rejects(
    () =>
      createOwnerSubscriptionTier({
        key: `${key}_bad`,
        name: "Bad",
        monthlyFeeUsd: "10",
        includedUsdMicros: "1000000",
        overageRateUsd: "0",
      }),
    /overageRateUsd/,
  );

  await assert.rejects(
    () =>
      updateOwnerSubscriptionTier(created.id, {
        overageRateUsd: "0",
      }),
    /overageRateUsd/,
  );

  const updated = await updateOwnerSubscriptionTier(created.id, {
    name: "Coverage Tier 2",
    monthlyFeeUsd: "18.5",
    overageRateUsd: null,
    active: false,
  });
  assert.equal(updated.name, "Coverage Tier 2");
  assert.equal(updated.monthlyFeeUsd, "18.50");
  assert.equal(updated.overageRateUsd, null);
  assert.equal(updated.active, 0);

  await markOwnerSubscriptionTierSynced({
    id: created.id,
    openmeterPlanId: "plan_cov_1",
  });
  const synced = await getOwnerSubscriptionTierByKey(key);
  assert.equal(synced?.openmeterPlanId, "plan_cov_1");
});
