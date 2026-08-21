import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import { eq } from "drizzle-orm";

import { db } from "@/db/index";
import { ownerBillingConfig, transactions } from "@/db/schema";
import { listAdminBillingOwners } from "@/lib/billing/admin-owner-list";
import { setOwnerBillingOverrides } from "@/lib/billing/owner-billing-config";
import { test } from "@/test-utils/db-guard";
import {
  cleanupTestApp,
  seedDeveloperAppWithClient,
  type SeededDeveloperApp,
} from "@/test-utils/fixtures";

async function insertCycleUsage(appId: string, usedUsdMicros: string): Promise<void> {
  await db.insert(transactions).values({
    id: `tx-admin-owner-list-${randomUUID()}`,
    clientId: appId,
    appId,
    type: "usage",
    status: "confirmed",
    amountWei: "0",
    networkFeeUsdMicros: usedUsdMicros,
    createdAt: new Date().toISOString(),
  });
}

test("admin owner list finds owner by app name and sorts by cycle usage", async (t) => {
  const token = randomUUID().slice(0, 8);
  const heavyName = `cs-heavy-app-${token}`;
  const lightName = `cs-light-app-${token}`;
  let heavy: SeededDeveloperApp | undefined;
  let light: SeededDeveloperApp | undefined;
  t.after(async () => {
    if (heavy) {
      await db
        .delete(ownerBillingConfig)
        .where(eq(ownerBillingConfig.ownerUserId, heavy.userId));
      await cleanupTestApp(heavy);
    }
    if (light) await cleanupTestApp(light);
  });

  heavy = await seedDeveloperAppWithClient({ name: heavyName });
  light = await seedDeveloperAppWithClient({ name: lightName });
  await setOwnerBillingOverrides({
    ownerUserId: heavy.userId,
    starterIncludedUsdMicros: "5000000",
    updatedBy: heavy.userId,
  });
  await insertCycleUsage(heavy.clientId, "8000000");
  await insertCycleUsage(light.clientId, "1000000");

  const byApp = await listAdminBillingOwners({
    q: heavyName,
    page: 1,
    pageSize: 25,
    status: "all",
  });
  assert.equal(byApp.owners.length, 1);
  assert.equal(byApp.owners[0]?.id, heavy.userId);
  assert.equal(byApp.owners[0]?.ownedApps[0]?.name, heavyName);
  assert.equal(byApp.owners[0]?.cycleUsage.usedUsdMicros, "8000000");
  assert.equal(byApp.owners[0]?.usageStatus, "blocked");

  const attention = await listAdminBillingOwners({
    q: token,
    page: 1,
    pageSize: 25,
    status: "attention",
  });
  const attentionIds = attention.owners.map((owner) => owner.id);
  assert.ok(attentionIds.includes(heavy.userId));
  assert.equal(attentionIds[0], heavy.userId, "highest usage is first");
});
