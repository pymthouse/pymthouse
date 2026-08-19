import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import { and, eq } from "drizzle-orm";
import { db } from "@/db/index";
import { appUserStripeCustomers } from "@/db/schema";
import { findOrCreateAppEndUser } from "@/lib/billing/end-users";
import {
  resetBillingIdentityCache,
  resolveOpenMeterBillingIdentity,
} from "@/lib/openmeter/billing-identity";
import { upsertAppBillingConfig } from "@/lib/openmeter/billing-profiles";
import {
  buildEndUserCustomerKey,
  buildOpenMeterCustomerKey,
} from "@/lib/openmeter/customer-key";
import {
  ensureMerchantOwnedStripeCustomer,
  upsertAppUserStripeCustomer,
} from "@/lib/stripe/merchant-connect";
import { test } from "@/test-utils/db-guard";
import {
  cleanupTestApp,
  seedDeveloperAppWithClient,
} from "@/test-utils/fixtures";

test("upsertAppUserStripeCustomer persists the canonical eu_ key, not a compound key", async (t) => {
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
  const canonicalKey = buildEndUserCustomerKey(endUserRowId);
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
