import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import { and, eq } from "drizzle-orm";
import { db } from "@/db/index";
import { appUserStripeCustomers } from "@/db/schema";
import { findOrCreateAppEndUser } from "@/lib/billing/end-users";
import {
  appUserRetailCustomerKey,
  resetBillingIdentityCache,
  resolveOpenMeterBillingIdentity,
} from "@/lib/openmeter/billing-identity";
import {
  getAppBillingConfig,
  upsertAppBillingConfig,
} from "@/lib/openmeter/billing-profiles";
import {
  buildOpenMeterCustomerKey,
  buildSandboxEndUserCustomerKey,
} from "@/lib/openmeter/customer-key";
import {
  applyConnectedAccountWebhookUpdate,
  ensureMerchantOwnedStripeCustomer,
  upsertAppUserStripeCustomer,
} from "@/lib/stripe/merchant-connect";
import { test } from "@/test-utils/db-guard";
import {
  cleanupTestApp,
  seedDeveloperAppWithClient,
} from "@/test-utils/fixtures";

test("upsertAppUserStripeCustomer persists the canonical sandbox sbx_eu_ key, not a compound key", async (t) => {
  const app = await seedDeveloperAppWithClient({
    name: `StripeMap ${randomUUID().slice(0, 8)}`,
  });
  t.after(async () => {
    await cleanupTestApp(app);
  });

  await upsertAppBillingConfig(app.clientId, { billingMode: "merchant" });
  resetBillingIdentityCache();

  const externalUserId = `eu_${randomUUID().replaceAll("-", "")}`;
  const { id: endUserRowId } = await findOrCreateAppEndUser(
    app.clientId,
    externalUserId,
  );
  const canonicalKey = buildSandboxEndUserCustomerKey(endUserRowId);
  const legacyKey = buildOpenMeterCustomerKey(app.clientId, externalUserId);

  await upsertAppUserStripeCustomer({
    clientId: app.clientId,
    externalUserId,
    stripeConnectedAccountId: "acct_test_canonical",
    stripeCustomerId: "cus_test_canonical",
    openmeterCustomerId: "01LEGACYCUSTOMERID0000000001",
    openmeterCustomerKey: legacyKey,
  });

  const rows = await db
    .select()
    .from(appUserStripeCustomers)
    .where(
      and(
        eq(appUserStripeCustomers.clientId, app.clientId),
        eq(appUserStripeCustomers.externalUserId, externalUserId),
      ),
    )
    .limit(1);
  assert.equal(rows[0]?.openmeterCustomerKey, canonicalKey);
  assert.equal(rows[0]?.openmeterCustomerId, null);
  assert.notEqual(rows[0]?.openmeterCustomerKey, legacyKey);
  assert.notEqual(canonicalKey, externalUserId);

  await upsertAppUserStripeCustomer({
    clientId: app.clientId,
    externalUserId,
    stripeConnectedAccountId: "acct_test_canonical",
    stripeCustomerId: "cus_test_canonical",
    openmeterCustomerId: "01CANONICALCUSTOMERID00000001",
    openmeterCustomerKey: canonicalKey,
  });
  const repaired = await db
    .select()
    .from(appUserStripeCustomers)
    .where(
      and(
        eq(appUserStripeCustomers.clientId, app.clientId),
        eq(appUserStripeCustomers.externalUserId, externalUserId),
      ),
    )
    .limit(1);
  assert.equal(repaired[0]?.openmeterCustomerKey, canonicalKey);
  assert.equal(repaired[0]?.openmeterCustomerId, "01CANONICALCUSTOMERID00000001");
});

test("ensureMerchantOwnedStripeCustomer repairs a legacy compound key on an existing mapping", async (t) => {
  const app = await seedDeveloperAppWithClient({
    name: `StripeRepair ${randomUUID().slice(0, 8)}`,
  });
  t.after(async () => {
    await cleanupTestApp(app);
  });

  await upsertAppBillingConfig(app.clientId, { billingMode: "merchant" });
  resetBillingIdentityCache();

  const externalUserId = `eu_${randomUUID().replaceAll("-", "")}`;
  const identity = await resolveOpenMeterBillingIdentity({
    clientId: app.clientId,
    externalUserId,
  });
  const legacyKey = identity.legacyCompoundCustomerKey;
  assert.ok(legacyKey);

  await db.insert(appUserStripeCustomers).values({
    id: randomUUID(),
    clientId: app.clientId,
    externalUserId,
    stripeConnectedAccountId: "acct_test_repair",
    stripeCustomerId: "cus_test_repair",
    openmeterCustomerId: "01LEGACYCUSTOMERID0000000002",
    openmeterCustomerKey: legacyKey,
  });

  const stripeCustomerId = await ensureMerchantOwnedStripeCustomer({
    clientId: app.clientId,
    externalUserId,
    accountId: "acct_test_repair",
    openmeterCustomerId: "01LEGACYCUSTOMERID0000000002",
    openmeterCustomerKey: legacyKey,
  });

  assert.equal(stripeCustomerId, "cus_test_repair");
  const rows = await db
    .select()
    .from(appUserStripeCustomers)
    .where(
      and(
        eq(appUserStripeCustomers.clientId, app.clientId),
        eq(appUserStripeCustomers.externalUserId, externalUserId),
      ),
    )
    .limit(1);
  assert.equal(rows[0]?.openmeterCustomerKey, identity.customerKey);
  assert.equal(rows[0]?.openmeterCustomerId, null);
  assert.equal(rows[0]?.stripeCustomerId, "cus_test_repair");
});

test("ensureMerchantOwnedStripeCustomer stamps retail eu_ key under owner_rollup connectPaymentsOnly", async (t) => {
  const app = await seedDeveloperAppWithClient({
    name: `StripeRetail ${randomUUID().slice(0, 8)}`,
  });
  t.after(async () => {
    await cleanupTestApp(app);
  });

  await upsertAppBillingConfig(app.clientId, {
    billingMode: "owner_rollup",
    connectPaymentsOnly: true,
  });
  resetBillingIdentityCache();

  const externalUserId = `eu_${randomUUID().replaceAll("-", "")}`;
  const identity = await resolveOpenMeterBillingIdentity({
    clientId: app.clientId,
    externalUserId,
  });
  const retailKey = appUserRetailCustomerKey(identity);
  assert.notEqual(retailKey, identity.customerKey);

  await db.insert(appUserStripeCustomers).values({
    id: randomUUID(),
    clientId: app.clientId,
    externalUserId,
    stripeConnectedAccountId: "acct_test_retail",
    stripeCustomerId: "cus_test_retail",
    openmeterCustomerId: "01OWNERCUSTOMERID00000000001",
    openmeterCustomerKey: identity.customerKey,
  });

  const stripeCustomerId = await ensureMerchantOwnedStripeCustomer({
    clientId: app.clientId,
    externalUserId,
    accountId: "acct_test_retail",
    openmeterCustomerId: "01OWNERCUSTOMERID00000000001",
    openmeterCustomerKey: identity.customerKey,
  });

  assert.equal(stripeCustomerId, "cus_test_retail");
  const rows = await db
    .select()
    .from(appUserStripeCustomers)
    .where(
      and(
        eq(appUserStripeCustomers.clientId, app.clientId),
        eq(appUserStripeCustomers.externalUserId, externalUserId),
      ),
    )
    .limit(1);
  assert.equal(rows[0]?.openmeterCustomerKey, retailKey);
  assert.equal(rows[0]?.openmeterCustomerId, null);
});

test("applyConnectedAccountWebhookUpdate ignores livemode mismatch", async (t) => {
  const app = await seedDeveloperAppWithClient({
    name: `StripeLiveMismatch ${randomUUID().slice(0, 8)}`,
  });
  t.after(async () => {
    await cleanupTestApp(app);
  });

  await upsertAppBillingConfig(app.clientId, {
    billingMode: "merchant",
    stripeConnectedAccountId: "acct_livemode_mismatch",
    stripeLivemode: true,
    stripeChargesEnabled: false,
  });

  const result = await applyConnectedAccountWebhookUpdate({
    accountId: "acct_livemode_mismatch",
    chargesEnabled: true,
    payoutsEnabled: true,
    detailsSubmitted: true,
    expectedLivemode: false,
  });
  assert.equal(result.updated, false);
  assert.equal(result.clientId, app.clientId);
  assert.equal(result.ignored, "livemode_mismatch");

  const config = await getAppBillingConfig(app.clientId);
  assert.equal(config?.stripeChargesEnabled, false);
});
