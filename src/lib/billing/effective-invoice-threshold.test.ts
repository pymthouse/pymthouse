import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import nodeTest from "node:test";
import { eq } from "drizzle-orm";

import { db } from "@/db/index";
import { plans, subscriptions } from "@/db/schema";
import {
  pickEffectiveThresholdUsdMicros,
  resolveEffectiveInvoiceThresholdUsdMicros,
  syncAppInvoiceThresholdFromUsagePlans,
} from "@/lib/billing/effective-invoice-threshold";
import {
  getAppBillingConfig,
  upsertAppBillingConfig,
} from "@/lib/openmeter/billing-profiles";
import { test } from "@/test-utils/db-guard";
import { cleanupTestApp, seedDeveloperAppWithClient } from "@/test-utils/fixtures";

nodeTest("pickEffectiveThresholdUsdMicros rejects non-positive and garbage", () => {
  assert.equal(
    pickEffectiveThresholdUsdMicros({
      planChargeThresholdUsdMicros: "0",
      appInvoiceThresholdUsdMicros: "-1",
    }),
    null,
  );
  assert.equal(
    pickEffectiveThresholdUsdMicros({
      planChargeThresholdUsdMicros: "not-a-number",
      appInvoiceThresholdUsdMicros: "abc",
    }),
    null,
  );
  assert.equal(
    pickEffectiveThresholdUsdMicros({
      planChargeThresholdUsdMicros: "  ",
      appInvoiceThresholdUsdMicros: undefined,
    }),
    null,
  );
});

nodeTest("resolveEffectiveInvoiceThresholdUsdMicros returns null for blank app id", async () => {
  assert.equal(
    await resolveEffectiveInvoiceThresholdUsdMicros({ appId: "  " }),
    null,
  );
});

nodeTest("syncAppInvoiceThresholdFromUsagePlans returns null for blank app id", async () => {
  assert.equal(await syncAppInvoiceThresholdFromUsagePlans(" "), null);
});

test("resolveEffectiveInvoiceThresholdUsdMicros uses app threshold without end-user", async (t) => {
  const app = await seedDeveloperAppWithClient({ status: "approved" });
  t.after(async () => {
    await cleanupTestApp(app);
  });

  await upsertAppBillingConfig(app.clientId, {
    invoiceThresholdUsdMicros: "7500000",
  });

  const threshold = await resolveEffectiveInvoiceThresholdUsdMicros({
    appId: app.clientId,
  });
  assert.equal(threshold, 7_500_000n);
});

test("resolveEffectiveInvoiceThresholdUsdMicros prefers active usage-plan charge threshold", async (t) => {
  const app = await seedDeveloperAppWithClient({ status: "approved" });
  const planId = `plan_thr_${randomUUID()}`;
  const subId = `sub_thr_${randomUUID()}`;
  const externalUserId = `eu_${randomUUID().slice(0, 8)}`;

  t.after(async () => {
    await db.delete(subscriptions).where(eq(subscriptions.id, subId));
    await db.delete(plans).where(eq(plans.id, planId));
    await cleanupTestApp(app);
  });

  await upsertAppBillingConfig(app.clientId, {
    invoiceThresholdUsdMicros: "10000000",
  });
  await db.insert(plans).values({
    id: planId,
    clientId: app.clientId,
    name: "PPU",
    type: "usage",
    status: "active",
    priceAmount: "0",
    chargeThresholdUsdMicros: "2500000",
  });
  await db.insert(subscriptions).values({
    id: subId,
    clientId: app.clientId,
    planId,
    status: "active",
    externalUserId,
  });

  const threshold = await resolveEffectiveInvoiceThresholdUsdMicros({
    appId: app.clientId,
    externalUserId,
  });
  assert.equal(threshold, 2_500_000n);
});

test("syncAppInvoiceThresholdFromUsagePlans stores the lowest active usage threshold", async (t) => {
  const app = await seedDeveloperAppWithClient({ status: "approved" });
  const highId = `plan_hi_${randomUUID()}`;
  const lowId = `plan_lo_${randomUUID()}`;

  t.after(async () => {
    await db.delete(plans).where(eq(plans.id, highId));
    await db.delete(plans).where(eq(plans.id, lowId));
    await cleanupTestApp(app);
  });

  await db.insert(plans).values([
    {
      id: highId,
      clientId: app.clientId,
      name: "High",
      type: "usage",
      status: "active",
      priceAmount: "0",
      chargeThresholdUsdMicros: "20000000",
    },
    {
      id: lowId,
      clientId: app.clientId,
      name: "Low",
      type: "usage",
      status: "active",
      priceAmount: "0",
      chargeThresholdUsdMicros: "3000000",
    },
  ]);

  const synced = await syncAppInvoiceThresholdFromUsagePlans(app.clientId);
  assert.equal(synced, "3000000");
  const config = await getAppBillingConfig(app.clientId);
  assert.equal(config?.invoiceThresholdUsdMicros, "3000000");

  // Idempotent when unchanged.
  const again = await syncAppInvoiceThresholdFromUsagePlans(app.clientId);
  assert.equal(again, "3000000");
});

test("syncAppInvoiceThresholdFromUsagePlans clears when no usage thresholds remain", async (t) => {
  const app = await seedDeveloperAppWithClient({ status: "approved" });
  t.after(async () => {
    await cleanupTestApp(app);
  });

  await upsertAppBillingConfig(app.clientId, {
    invoiceThresholdUsdMicros: "5000000",
  });
  const cleared = await syncAppInvoiceThresholdFromUsagePlans(app.clientId);
  assert.equal(cleared, null);
  const config = await getAppBillingConfig(app.clientId);
  assert.equal(config?.invoiceThresholdUsdMicros ?? null, null);
});
