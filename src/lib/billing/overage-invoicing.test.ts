import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { eq } from "drizzle-orm";

import { db } from "@/db/index";
import { plans, subscriptions } from "@/db/schema";
import {
  appUserAllowsOverageInvoicing,
  appUserHasOverageCapablePlan,
  decideAllowsOverageInvoicing,
  resolveAllowsOverageInvoicing,
} from "@/lib/billing/overage-invoicing";
import { mintAllowanceGateDecision } from "@/lib/oidc/mint-user-signer-token";
import { upsertAppBillingConfig } from "@/lib/openmeter/billing-profiles";
import { appUserHasChargeablePaymentMethod } from "@/lib/openmeter/app-user-payment-method";
import { test as dbTest } from "@/test-utils/db-guard";
import { cleanupTestApp, seedDeveloperAppWithClient } from "@/test-utils/fixtures";

test("decideAllowsOverageInvoicing: merchant + chargeable + usage plan → allow", () => {
  assert.equal(
    decideAllowsOverageInvoicing({
      isOwner: false,
      billingMode: "merchant",
      ownerAllowsOverage: false,
      merchantConnectReady: true,
      merchantChargeable: true,
      merchantHasOverageCapablePlan: true,
    }),
    true,
  );
});

test("decideAllowsOverageInvoicing: merchant no PM → deny", () => {
  assert.equal(
    decideAllowsOverageInvoicing({
      isOwner: false,
      billingMode: "merchant",
      ownerAllowsOverage: true,
      merchantConnectReady: true,
      merchantChargeable: false,
      merchantHasOverageCapablePlan: true,
    }),
    false,
  );
});

test("decideAllowsOverageInvoicing: merchant chargeability null fails closed", () => {
  assert.equal(
    decideAllowsOverageInvoicing({
      isOwner: false,
      billingMode: "merchant",
      ownerAllowsOverage: false,
      merchantConnectReady: true,
      merchantChargeable: null,
      merchantHasOverageCapablePlan: true,
    }),
    false,
  );
});

test("decideAllowsOverageInvoicing: merchant starter/free plan → deny", () => {
  assert.equal(
    decideAllowsOverageInvoicing({
      isOwner: false,
      billingMode: "merchant",
      ownerAllowsOverage: false,
      merchantConnectReady: true,
      merchantChargeable: true,
      merchantHasOverageCapablePlan: false,
    }),
    false,
  );
});

test("decideAllowsOverageInvoicing: rollup + owner Paid+PM → allow", () => {
  assert.equal(
    decideAllowsOverageInvoicing({
      isOwner: false,
      billingMode: "owner_rollup",
      ownerAllowsOverage: true,
      merchantConnectReady: false,
      merchantChargeable: false,
      merchantHasOverageCapablePlan: false,
    }),
    true,
  );
});

test("decideAllowsOverageInvoicing: rollup owner Starter → deny", () => {
  assert.equal(
    decideAllowsOverageInvoicing({
      isOwner: false,
      billingMode: "owner_rollup",
      ownerAllowsOverage: false,
      merchantConnectReady: true,
      merchantChargeable: true,
      merchantHasOverageCapablePlan: true,
    }),
    false,
  );
});

test("decideAllowsOverageInvoicing: owner identity uses owner predicate only", () => {
  assert.equal(
    decideAllowsOverageInvoicing({
      isOwner: true,
      billingMode: "merchant",
      ownerAllowsOverage: true,
      merchantConnectReady: false,
      merchantChargeable: false,
      merchantHasOverageCapablePlan: false,
    }),
    true,
  );
  assert.equal(
    decideAllowsOverageInvoicing({
      isOwner: true,
      billingMode: "merchant",
      ownerAllowsOverage: false,
      merchantConnectReady: true,
      merchantChargeable: true,
      merchantHasOverageCapablePlan: true,
    }),
    false,
  );
});

test("mintAllowanceGateDecision still denies zero spendable without overage", () => {
  assert.deepEqual(
    mintAllowanceGateDecision(
      {
        hasAccess: false,
        balanceUsdMicros: "0",
        consumedUsdMicros: "0",
        lifetimeGrantedUsdMicros: "0",
      },
      true,
      { allowsOverageInvoicing: false },
    ),
    {
      code: "trial_credits_exhausted",
      message: "Payment method required",
      reason: "no_payment_method",
    },
  );
});

test("mintAllowanceGateDecision carries an explicit deny reason", () => {
  assert.deepEqual(
    mintAllowanceGateDecision(
      {
        hasAccess: false,
        balanceUsdMicros: "0",
        consumedUsdMicros: "0",
        lifetimeGrantedUsdMicros: "0",
      },
      true,
      { allowsOverageInvoicing: false, reason: "debt_ceiling_reached" },
    ),
    {
      code: "trial_credits_exhausted",
      message: "Overage limit reached while payment is collected",
      reason: "debt_ceiling_reached",
    },
  );
});

test("mintAllowanceGateDecision allows zero spendable with overage flag", () => {
  assert.equal(
    mintAllowanceGateDecision(
      {
        hasAccess: false,
        balanceUsdMicros: "0",
        consumedUsdMicros: "0",
        lifetimeGrantedUsdMicros: "0",
      },
      true,
      { allowsOverageInvoicing: true },
    ),
    null,
  );
});

test("appUserHasOverageCapablePlan and appUserAllowsOverageInvoicing deny blank ids", async () => {
  assert.equal(
    await appUserHasOverageCapablePlan({ appId: "", externalUserId: "eu" }),
    false,
  );
  assert.equal(
    await appUserHasOverageCapablePlan({ appId: "app", externalUserId: " " }),
    false,
  );
  assert.equal(
    await appUserAllowsOverageInvoicing({ appId: "", externalUserId: "eu" }),
    false,
  );
  assert.equal(
    await appUserAllowsOverageInvoicing({ appId: "app", externalUserId: "" }),
    false,
  );
});

test("resolveAllowsOverageInvoicing denies blank external user", async () => {
  assert.equal(
    await resolveAllowsOverageInvoicing({
      clientId: "app_x",
      externalUserId: "  ",
    }),
    false,
  );
});

test("resolveAllowsOverageInvoicing owner path fails closed without hosted OM", async () => {
  assert.equal(
    await resolveAllowsOverageInvoicing({
      clientId: "app_owner_gate",
      externalUserId: "owner_user_1",
      identity: {
        customerKey: "owner_user_1",
        isOwner: true,
        ownerUserId: "owner_user_1",
        publicClientId: "app_owner_gate",
        developerAppId: "app_owner_gate",
      },
    }),
    false,
  );
});

test("appUserHasChargeablePaymentMethod early returns", async () => {
  assert.equal(
    await appUserHasChargeablePaymentMethod({
      clientId: "",
      externalUserId: "eu",
    }),
    false,
  );
  const prevSecret = process.env.STRIPE_SECRET_KEY;
  const prevApi = process.env.STRIPE_API_KEY;
  delete process.env.STRIPE_SECRET_KEY;
  delete process.env.STRIPE_API_KEY;
  try {
    assert.equal(
      await appUserHasChargeablePaymentMethod({
        clientId: "app_pm",
        externalUserId: "eu_1",
      }),
      null,
    );
  } finally {
    if (prevSecret === undefined) delete process.env.STRIPE_SECRET_KEY;
    else process.env.STRIPE_SECRET_KEY = prevSecret;
    if (prevApi === undefined) delete process.env.STRIPE_API_KEY;
    else process.env.STRIPE_API_KEY = prevApi;
  }
});

dbTest("appUserHasOverageCapablePlan does not trust Neon status alone", async (t) => {
  const app = await seedDeveloperAppWithClient({ status: "approved" });
  const planId = `plan_ov_${randomUUID()}`;
  const subId = `sub_ov_${randomUUID()}`;
  const externalUserId = `eu_ov_${randomUUID().slice(0, 8)}`;
  t.after(async () => {
    await db.delete(subscriptions).where(eq(subscriptions.id, subId));
    await db.delete(plans).where(eq(plans.id, planId));
    await cleanupTestApp(app);
  });

  await db.insert(plans).values({
    id: planId,
    clientId: app.clientId,
    name: "Usage",
    type: "usage",
    status: "active",
    priceAmount: "0",
  });
  // Neon "active" without a live OpenMeter primary sub must not unlock.
  await db.insert(subscriptions).values({
    id: subId,
    clientId: app.clientId,
    planId,
    status: "active",
    externalUserId,
  });

  assert.equal(
    await appUserHasOverageCapablePlan({
      appId: app.clientId,
      externalUserId,
    }),
    false,
  );
  assert.equal(
    await appUserHasOverageCapablePlan({
      appId: "",
      externalUserId: "eu",
    }),
    false,
  );
});

dbTest("appUserAllowsOverageInvoicing requires merchant billing mode", async (t) => {
  const app = await seedDeveloperAppWithClient({ status: "approved" });
  t.after(async () => {
    await cleanupTestApp(app);
  });

  await upsertAppBillingConfig(app.clientId, {
    billingMode: "owner_rollup",
  });
  assert.equal(
    await appUserAllowsOverageInvoicing({
      appId: app.clientId,
      externalUserId: "eu_any",
    }),
    false,
  );
});

dbTest("resolveAllowsOverageInvoicing merchant path fails closed without Connect PM", async (t) => {
  const app = await seedDeveloperAppWithClient({ status: "approved" });
  const planId = `plan_m_${randomUUID()}`;
  const subId = `sub_m_${randomUUID()}`;
  const externalUserId = `eu_m_${randomUUID().slice(0, 8)}`;
  t.after(async () => {
    await db.delete(subscriptions).where(eq(subscriptions.id, subId));
    await db.delete(plans).where(eq(plans.id, planId));
    await cleanupTestApp(app);
  });

  await upsertAppBillingConfig(app.clientId, {
    billingMode: "merchant",
    stripeConnectStatus: "connected",
    stripeConnectedAccountId: "acct_test_merchant",
    stripeChargesEnabled: true,
    stripeDetailsSubmitted: true,
  });
  await db.insert(plans).values({
    id: planId,
    clientId: app.clientId,
    name: "Usage",
    type: "usage",
    status: "active",
    priceAmount: "0",
  });
  await db.insert(subscriptions).values({
    id: subId,
    clientId: app.clientId,
    planId,
    status: "active",
    externalUserId,
  });

  assert.equal(
    await resolveAllowsOverageInvoicing({
      clientId: app.clientId,
      externalUserId,
      identity: {
        customerKey: `${app.clientId}:${externalUserId}`,
        isOwner: false,
        publicClientId: app.clientId,
        developerAppId: app.clientId,
      },
    }),
    false,
  );
});

dbTest("resolveAllowsOverageInvoicing rollup path fails closed without owner Paid", async (t) => {
  const app = await seedDeveloperAppWithClient({ status: "approved" });
  t.after(async () => {
    await cleanupTestApp(app);
  });

  await upsertAppBillingConfig(app.clientId, {
    billingMode: "owner_rollup",
  });

  assert.equal(
    await resolveAllowsOverageInvoicing({
      clientId: app.clientId,
      externalUserId: "eu_rollup",
      identity: {
        customerKey: `${app.clientId}:eu_rollup`,
        isOwner: false,
        publicClientId: app.clientId,
        developerAppId: app.clientId,
      },
    }),
    false,
  );
});
