import assert from "node:assert/strict";
import { eq } from "drizzle-orm";

import { db } from "@/db/index";
import { platformBillingSettings, users } from "@/db/schema";
import {
  PLATFORM_BILLING_SETTINGS_ID,
  normalizeOwnerStarterPlanName,
  resolvePlatformOwnerStarterDefault,
  setPlatformOwnerStarterIncludedUsdMicros,
} from "@/lib/billing/platform-owner-starter-default";
import { test } from "@/test-utils/db-guard";
import { createTestUser } from "@/test-utils/fixtures";

test("platform owner starter default resolves env/fallback without a DB row", async () => {
  await db
    .delete(platformBillingSettings)
    .where(eq(platformBillingSettings.id, PLATFORM_BILLING_SETTINGS_ID));

  const prior = process.env.OPENMETER_DEFAULT_STARTER_INCLUDED_USD_MICROS;
  delete process.env.OPENMETER_DEFAULT_STARTER_INCLUDED_USD_MICROS;
  try {
    const resolved = await resolvePlatformOwnerStarterDefault();
    assert.equal(resolved.ownerStarterIncludedUsdMicros, "5000000");
    assert.equal(resolved.ownerStarterPlanName, "Owner Sandbox Starter");
    assert.equal(resolved.source, "fallback");
  } finally {
    if (prior === undefined) {
      delete process.env.OPENMETER_DEFAULT_STARTER_INCLUDED_USD_MICROS;
    } else {
      process.env.OPENMETER_DEFAULT_STARTER_INCLUDED_USD_MICROS = prior;
    }
  }
});

test("platform owner starter default prefers DB over env", async (t) => {
  const adminId = await createTestUser({ role: "admin" });
  const prior = process.env.OPENMETER_DEFAULT_STARTER_INCLUDED_USD_MICROS;
  process.env.OPENMETER_DEFAULT_STARTER_INCLUDED_USD_MICROS = "1000000";

  t.after(async () => {
    if (prior === undefined) {
      delete process.env.OPENMETER_DEFAULT_STARTER_INCLUDED_USD_MICROS;
    } else {
      process.env.OPENMETER_DEFAULT_STARTER_INCLUDED_USD_MICROS = prior;
    }
    await db
      .delete(platformBillingSettings)
      .where(eq(platformBillingSettings.id, PLATFORM_BILLING_SETTINGS_ID));
    await db.delete(users).where(eq(users.id, adminId));
  });

  const saved = await setPlatformOwnerStarterIncludedUsdMicros({
    ownerStarterIncludedUsdMicros: "25000000",
    ownerStarterPlanName: "Developer Free Tier",
    updatedBy: ` ${adminId} `,
  });
  assert.equal(saved.source, "db");
  assert.equal(saved.ownerStarterIncludedUsdMicros, "25000000");
  assert.equal(saved.ownerStarterPlanName, "Developer Free Tier");
  assert.equal(saved.updatedBy, adminId);

  const resolved = await resolvePlatformOwnerStarterDefault();
  assert.equal(resolved.source, "db");
  assert.equal(resolved.ownerStarterIncludedUsdMicros, "25000000");
  assert.equal(resolved.ownerStarterPlanName, "Developer Free Tier");
});

test("normalizeOwnerStarterPlanName falls back and rejects overlong names", () => {
  assert.equal(normalizeOwnerStarterPlanName(""), "Owner Sandbox Starter");
  assert.equal(normalizeOwnerStarterPlanName("  Free  Tier  "), "Free Tier");
  assert.throws(
    () => normalizeOwnerStarterPlanName("x".repeat(81)),
    /at most 80/,
  );
});
