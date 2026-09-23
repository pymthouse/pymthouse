import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import { eq } from "drizzle-orm";

import { db } from "@/db/index";
import { appUsers, ownerBillingConfig, transactions } from "@/db/schema";
import {
  getAdminBillingApp,
  listAdminBillingApps,
} from "@/lib/billing/admin-app-rollup";
import { listAdminBillingOwners } from "@/lib/billing/admin-owner-list";
import { setOwnerBillingOverrides } from "@/lib/billing/owner-billing-config";
import { test } from "@/test-utils/db-guard";
import {
  cleanupTestApp,
  createAppUser,
  seedDeveloperAppWithClient,
  type SeededDeveloperApp,
} from "@/test-utils/fixtures";

async function insertCycleUsage(appId: string, usedUsdMicros: string): Promise<void> {
  await db.insert(transactions).values({
    id: `tx-admin-app-rollup-${randomUUID()}`,
    clientId: appId,
    appId,
    type: "usage",
    status: "confirmed",
    amountWei: "0",
    networkFeeUsdMicros: usedUsdMicros,
    createdAt: new Date().toISOString(),
  });
}

test("admin app list finds owner-rollup app by M2M email and flags blocked users", async (t) => {
  const token = randomUUID().slice(0, 8);
  const appName = `Livepeer Dashboard 2.0 ${token}`;
  const m2mEmail = `blocked-m2m-${token}@example.test`;
  let seeded: SeededDeveloperApp | undefined;
  t.after(async () => {
    if (seeded) {
      await db
        .delete(ownerBillingConfig)
        .where(eq(ownerBillingConfig.ownerUserId, seeded.userId));
      await cleanupTestApp(seeded);
    }
  });

  seeded = await seedDeveloperAppWithClient({ name: appName });
  const m2m = await createAppUser({
    clientId: seeded.clientId,
    externalUserId: `lp-dash-${token}`,
  });
  await db
    .update(appUsers)
    .set({ email: m2mEmail })
    .where(eq(appUsers.id, m2m.id));
  await setOwnerBillingOverrides({
    ownerUserId: seeded.userId,
    starterIncludedUsdMicros: "5000000",
    updatedBy: seeded.userId,
  });
  await insertCycleUsage(seeded.clientId, "8000000");

  const byUser = await listAdminBillingApps({
    q: m2mEmail,
    page: 1,
    pageSize: 25,
    status: "all",
    billingMode: "all",
  });
  assert.equal(byUser.apps.length, 1);
  assert.equal(byUser.apps[0]?.id, seeded.clientId);
  assert.equal(byUser.apps[0]?.billingMode, "owner_rollup");
  assert.equal(byUser.apps[0]?.sharesOwnerCostRail, true);
  assert.equal(byUser.apps[0]?.m2mUserCount, 1);
  assert.equal(byUser.apps[0]?.blockedM2mUserCount, 1);
  assert.equal(byUser.apps[0]?.owner.usageStatus, "blocked");
  assert.equal(byUser.apps[0]?.matchedUsers[0]?.email, m2mEmail);

  const attention = await listAdminBillingApps({
    q: token,
    page: 1,
    pageSize: 25,
    status: "attention",
    billingMode: "owner_rollup",
  });
  assert.ok(attention.apps.some((app) => app.id === seeded?.clientId));

  const owners = await listAdminBillingOwners({
    q: m2mEmail,
    page: 1,
    pageSize: 25,
    status: "all",
  });
  assert.equal(owners.owners.length, 1);
  assert.equal(owners.owners[0]?.id, seeded.userId);
  assert.equal(owners.owners[0]?.ownedApps[0]?.billingMode, "owner_rollup");

  const detail = await getAdminBillingApp(seeded.clientId, {
    q: "",
    page: 1,
    pageSize: 25,
  });
  assert.ok(detail);
  assert.equal(detail?.creditPolicy.m2mDirectGrants, "denied");
  assert.equal(detail?.creditPolicy.ownerGrantsUnblockM2m, true);
  assert.equal(detail?.users.items.length, 1);
  assert.equal(detail?.users.items[0]?.canGrantDirectly, false);
  assert.equal(detail?.users.items[0]?.spendable.source, "owner_wallet");
  assert.equal(detail?.users.items[0]?.externalUserId, `lp-dash-${token}`);
});
