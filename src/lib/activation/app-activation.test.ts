import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { TestContext } from "node:test";
import { and, eq } from "drizzle-orm";

import { db } from "@/db/index";
import { appBillingConfig, appUsers } from "@/db/schema";
import {
  __testDefaultEndUserCap,
  __testSetOwnerPaymentMethodLookup,
  __testSetSpendableLookup,
  AppActivationError,
  assertAppCanProvisionUsers,
  assertAppCanSellPaidPlans,
  getActivationGateMode,
  isConnectReady,
  resolveAppActivation,
  runActivationGate,
} from "@/lib/activation/app-activation";
import { buildActivationProblem } from "@/lib/activation/problem";
import { upsertAppBillingConfig } from "@/lib/openmeter/billing-profiles";
import { test } from "@/test-utils/db-guard";
import {
  cleanupTestApp,
  createAppUser,
  seedDeveloperAppWithClient,
} from "@/test-utils/fixtures";
import { withTemporaryPlatformDefault } from "@/test-utils/platform-default-lock";

/**
 * Both halves of the cost rail. `hasPaymentMethod: null` is the outage answer,
 * which must fail open.
 */
function stubOwnerBilling(
  t: TestContext,
  input: { spendableUsdMicros: string; hasPaymentMethod: boolean | null },
): void {
  __testSetSpendableLookup(async () => input.spendableUsdMicros);
  __testSetOwnerPaymentMethodLookup(async () => input.hasPaymentMethod);
  t.after(() => {
    __testSetSpendableLookup(null);
    __testSetOwnerPaymentMethodLookup(null);
  });
}

test("isConnectReady requires account, charges, and details_submitted", () => {
  assert.equal(isConnectReady(null), false);
  assert.equal(
    isConnectReady({
      stripeConnectedAccountId: "acct_1",
      stripeChargesEnabled: true,
      stripeDetailsSubmitted: false,
    }),
    false,
  );
  assert.equal(
    isConnectReady({
      stripeConnectedAccountId: "acct_1",
      stripeChargesEnabled: true,
      stripeDetailsSubmitted: true,
    }),
    true,
  );
});

test("getActivationGateMode defaults to off", (t) => {
  const prev = process.env.ACTIVATION_GATE_MODE;
  t.after(() => {
    if (prev === undefined) delete process.env.ACTIVATION_GATE_MODE;
    else process.env.ACTIVATION_GATE_MODE = prev;
  });
  delete process.env.ACTIVATION_GATE_MODE;
  assert.equal(getActivationGateMode(), "off");
  process.env.ACTIVATION_GATE_MODE = "enforce_revenue";
  assert.equal(getActivationGateMode(), "enforce_revenue");
});

test("buildActivationProblem uses 402 when there is nothing to charge", () => {
  const body = buildActivationProblem({
    reason: "owner_payment_method_required",
    billingMode: "owner_rollup",
    actionUrl: "https://example.com/billing",
    correlationId: "corr-1",
  });
  assert.equal(body.status, 402);
  assert.equal(body.code, "owner_payment_method_required");
  assert.equal(body.correlation_id, "corr-1");
});

test("resolveAppActivation defaults when billing config is missing", async (t) => {
  const seeded = await seedDeveloperAppWithClient();
  t.after(async () => cleanupTestApp(seeded));

  stubOwnerBilling(t, { spendableUsdMicros: "1000000", hasPaymentMethod: false });

  const activation = await resolveAppActivation(seeded.clientId);
  assert.equal(activation.billingMode, "owner_rollup");
  assert.equal(activation.connectReady, false);
  assert.equal(activation.canSellPaidPlans, false);
  assert.equal(activation.canProvisionEndUsers, true);
  assert.equal(activation.endUserCap, __testDefaultEndUserCap);
  assert.equal(activation.reason, "stripe_connect_required");
});

test("resolveAppActivation exempts platform default apps from provision checks", async (t) => {
  const seeded = await seedDeveloperAppWithClient();
  t.after(async () => cleanupTestApp(seeded));

  stubOwnerBilling(t, { spendableUsdMicros: "0", hasPaymentMethod: false });

  await withTemporaryPlatformDefault(seeded.clientId, async () => {
    const activation = await resolveAppActivation(seeded.clientId);
    assert.equal(activation.canProvisionEndUsers, true);
  });
});

test("resolveAppActivation blocks when charges_enabled or details_submitted false", async (t) => {
  const seeded = await seedDeveloperAppWithClient();
  t.after(async () => cleanupTestApp(seeded));

  await upsertAppBillingConfig(seeded.clientId, {
    billingMode: "merchant",
    stripeConnectedAccountId: "acct_pending",
    stripeChargesEnabled: false,
    stripeDetailsSubmitted: true,
  });

  stubOwnerBilling(t, { spendableUsdMicros: "1000000", hasPaymentMethod: false });

  const activation = await resolveAppActivation(seeded.clientId);
  assert.equal(activation.connectReady, false);
  assert.equal(activation.canSellPaidPlans, false);

  await db
    .update(appBillingConfig)
    .set({
      stripeChargesEnabled: true,
      stripeDetailsSubmitted: false,
    })
    .where(eq(appBillingConfig.clientId, seeded.clientId));

  const stillPending = await resolveAppActivation(seeded.clientId);
  assert.equal(stillPending.connectReady, false);
  assert.equal(stillPending.canSellPaidPlans, false);
});

test("resolveAppActivation blocks at end_user_cap boundary", async (t) => {
  const seeded = await seedDeveloperAppWithClient();
  t.after(async () => cleanupTestApp(seeded));

  await upsertAppBillingConfig(seeded.clientId, { endUserCap: 2 });
  stubOwnerBilling(t, { spendableUsdMicros: "1000000", hasPaymentMethod: false });

  await createAppUser({ clientId: seeded.clientId, externalUserId: "eu-1" });
  await createAppUser({ clientId: seeded.clientId, externalUserId: "eu-2" });

  const activation = await resolveAppActivation(seeded.clientId);
  assert.equal(activation.canProvisionEndUsers, false);
  assert.equal(activation.reason, "end_user_cap_reached");
  assert.equal(activation.appUserCount, 2);
});

test("resolveAppActivation counts only active end users toward the cap", async (t) => {
  const seeded = await seedDeveloperAppWithClient();
  t.after(async () => cleanupTestApp(seeded));

  await upsertAppBillingConfig(seeded.clientId, { endUserCap: 2 });
  stubOwnerBilling(t, { spendableUsdMicros: "1000000", hasPaymentMethod: false });

  await createAppUser({ clientId: seeded.clientId, externalUserId: "eu-1" });
  await createAppUser({ clientId: seeded.clientId, externalUserId: "eu-2" });
  await createAppUser({
    clientId: seeded.clientId,
    externalUserId: "eu-inactive",
    status: "inactive",
  });

  const atCap = await resolveAppActivation(seeded.clientId);
  assert.equal(atCap.canProvisionEndUsers, false);
  assert.equal(atCap.appUserCount, 2);

  await db
    .update(appUsers)
    .set({ status: "inactive" })
    .where(
      and(
        eq(appUsers.clientId, seeded.clientId),
        eq(appUsers.externalUserId, "eu-2"),
      ),
    );

  const afterDeactivate = await resolveAppActivation(seeded.clientId);
  assert.equal(afterDeactivate.canProvisionEndUsers, true);
  assert.equal(afterDeactivate.appUserCount, 1);
});

test("assertAppCanProvisionUsers gates inactive→active when at cap", async (t) => {
  const seeded = await seedDeveloperAppWithClient();
  t.after(async () => cleanupTestApp(seeded));

  await upsertAppBillingConfig(seeded.clientId, { endUserCap: 1 });
  stubOwnerBilling(t, { spendableUsdMicros: "1000000", hasPaymentMethod: false });

  await createAppUser({ clientId: seeded.clientId, externalUserId: "eu-active" });
  await createAppUser({
    clientId: seeded.clientId,
    externalUserId: "eu-inactive",
    status: "inactive",
  });

  // Inactive without activating still passes (billing ensure / non-lifecycle paths).
  const idle = await assertAppCanProvisionUsers(seeded.clientId, {
    externalUserId: "eu-inactive",
  });
  assert.ok(idle);

  await assert.rejects(
    () =>
      assertAppCanProvisionUsers(seeded.clientId, {
        externalUserId: "eu-inactive",
        activating: true,
      }),
    (err: unknown) =>
      err instanceof AppActivationError && err.code === "end_user_cap_reached",
  );
});

test("resolveAppActivation blocks an empty wallet with no payment method", async (t) => {
  const seeded = await seedDeveloperAppWithClient();
  t.after(async () => cleanupTestApp(seeded));

  stubOwnerBilling(t, { spendableUsdMicros: "0", hasPaymentMethod: false });

  const activation = await resolveAppActivation(seeded.clientId);
  assert.equal(activation.canProvisionEndUsers, false);
  assert.equal(activation.reason, "owner_payment_method_required");
});

test("resolveAppActivation allows an empty wallet on Owner Paid with a card", async (t) => {
  const seeded = await seedDeveloperAppWithClient();
  t.after(async () => cleanupTestApp(seeded));

  // Owner Paid + chargeable PM unlocks overage invoicing past spendable=0.
  stubOwnerBilling(t, { spendableUsdMicros: "0", hasPaymentMethod: true });

  const activation = await resolveAppActivation(seeded.clientId);
  assert.equal(activation.canProvisionEndUsers, true);
});

test("resolveAppActivation fails open when chargeability is unknown", async (t) => {
  const seeded = await seedDeveloperAppWithClient();
  t.after(async () => cleanupTestApp(seeded));

  stubOwnerBilling(t, { spendableUsdMicros: "0", hasPaymentMethod: null });

  const activation = await resolveAppActivation(seeded.clientId);
  assert.equal(activation.canProvisionEndUsers, true);
});

test("assertAppCanProvisionUsers allows existing app users (creation-only)", async (t) => {
  const seeded = await seedDeveloperAppWithClient();
  t.after(async () => cleanupTestApp(seeded));

  await createAppUser({ clientId: seeded.clientId, externalUserId: "eu-existing" });
  stubOwnerBilling(t, { spendableUsdMicros: "0", hasPaymentMethod: false });

  const activation = await assertAppCanProvisionUsers(seeded.clientId, {
    externalUserId: "eu-existing",
  });
  assert.ok(activation);

  await assert.rejects(
    () =>
      assertAppCanProvisionUsers(seeded.clientId, {
        externalUserId: `eu-new-${randomUUID()}`,
      }),
    (err: unknown) =>
      err instanceof AppActivationError &&
      err.code === "owner_payment_method_required",
  );
});

test("assertAppCanSellPaidPlans distinguishes required vs pending", async (t) => {
  const seeded = await seedDeveloperAppWithClient();
  t.after(async () => cleanupTestApp(seeded));

  stubOwnerBilling(t, { spendableUsdMicros: "1000000", hasPaymentMethod: false });

  await assert.rejects(
    () => assertAppCanSellPaidPlans(seeded.clientId),
    (err: unknown) =>
      err instanceof AppActivationError && err.code === "stripe_connect_required",
  );

  await upsertAppBillingConfig(seeded.clientId, {
    billingMode: "merchant",
    stripeConnectedAccountId: "acct_pending",
    stripeChargesEnabled: false,
    stripeDetailsSubmitted: false,
  });

  await assert.rejects(
    () => assertAppCanSellPaidPlans(seeded.clientId),
    (err: unknown) =>
      err instanceof AppActivationError && err.code === "stripe_connect_pending",
  );
});

test("runActivationGate mode matrix: off soft-allows, enforce denies", async (t) => {
  const seeded = await seedDeveloperAppWithClient();
  t.after(async () => cleanupTestApp(seeded));

  stubOwnerBilling(t, { spendableUsdMicros: "0", hasPaymentMethod: false });

  const prev = process.env.ACTIVATION_GATE_MODE;
  t.after(() => {
    if (prev === undefined) delete process.env.ACTIVATION_GATE_MODE;
    else process.env.ACTIVATION_GATE_MODE = prev;
  });

  process.env.ACTIVATION_GATE_MODE = "off";
  const soft = await runActivationGate("provision", seeded.clientId, {
    externalUserId: `eu-${randomUUID()}`,
  });
  assert.equal(soft.canProvisionEndUsers, false);

  process.env.ACTIVATION_GATE_MODE = "log";
  const logged = await runActivationGate("provision", seeded.clientId, {
    externalUserId: `eu-${randomUUID()}`,
  });
  assert.equal(logged.canProvisionEndUsers, false);

  process.env.ACTIVATION_GATE_MODE = "enforce_revenue";
  const revenueOnly = await runActivationGate("provision", seeded.clientId, {
    externalUserId: `eu-${randomUUID()}`,
  });
  assert.equal(revenueOnly.canProvisionEndUsers, false);

  process.env.ACTIVATION_GATE_MODE = "enforce";
  await assert.rejects(
    () =>
      runActivationGate("provision", seeded.clientId, {
        externalUserId: `eu-${randomUUID()}`,
      }),
    (err: unknown) => err instanceof AppActivationError,
  );
});
