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
  getAppUserStripeCustomer,
  getMerchantConnectPlane,
  startMerchantConnect,
  switchMerchantConnectPlane,
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

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

test("startMerchantConnect uses live Stripe when stripeLivemode true is requested", async (t) => {
  const app = await seedDeveloperAppWithClient({
    name: `StripeLiveOnboard ${randomUUID().slice(0, 8)}`,
  });
  t.after(async () => {
    await cleanupTestApp(app);
  });

  const previousLive = process.env.STRIPE_SECRET_KEY;
  const previousSandbox = process.env.STRIPE_SANDBOX_SECRET_KEY;
  const previousNextAuth = process.env.NEXTAUTH_URL;
  process.env.STRIPE_SECRET_KEY = "sk_live_unit_connect";
  process.env.STRIPE_SANDBOX_SECRET_KEY = "sk_test_sandbox_connect";
  process.env.NEXTAUTH_URL = "https://builder.example";
  t.after(() => {
    if (previousLive === undefined) delete process.env.STRIPE_SECRET_KEY;
    else process.env.STRIPE_SECRET_KEY = previousLive;
    if (previousSandbox === undefined) {
      delete process.env.STRIPE_SANDBOX_SECRET_KEY;
    } else {
      process.env.STRIPE_SANDBOX_SECRET_KEY = previousSandbox;
    }
    if (previousNextAuth === undefined) delete process.env.NEXTAUTH_URL;
    else process.env.NEXTAUTH_URL = previousNextAuth;
  });

  const auths: string[] = [];
  t.mock.method(globalThis, "fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    const auth = headers.get("Authorization");
    if (auth) auths.push(auth);
    const url = String(input);
    if (url.includes("/v2/core/accounts")) {
      return jsonResponse({ error: { message: "v2 unavailable" } }, 400);
    }
    if (url.includes("/v1/account_links")) {
      return jsonResponse({ url: "https://connect.stripe.com/setup/e/live" });
    }
    if (url.includes("/v1/accounts")) {
      if (init?.method === "POST") {
        return jsonResponse({ id: "acct_live_onboard" });
      }
      return jsonResponse({
        id: "acct_live_onboard",
        charges_enabled: false,
        payouts_enabled: false,
        details_submitted: false,
      });
    }
    return jsonResponse({ error: { message: `unexpected ${url}` } }, 500);
  });

  const result = await startMerchantConnect({
    clientId: app.clientId,
    userId: app.userId,
    stripeLivemode: true,
  });
  assert.equal(result.accountId, "acct_live_onboard");
  assert.equal(result.method, "account_link");
  assert.ok(auths.every((auth) => auth === "Bearer sk_live_unit_connect"));
  const config = await getAppBillingConfig(app.clientId);
  assert.equal(config?.stripeLivemode, true);
  assert.equal(config?.stripeConnectedAccountId, "acct_live_onboard");
});

test("startMerchantConnect defaults first Connect to sandbox without stripeLivemode", async (t) => {
  const app = await seedDeveloperAppWithClient({
    name: `StripeSbxOnboard ${randomUUID().slice(0, 8)}`,
  });
  t.after(async () => {
    await cleanupTestApp(app);
  });

  const previousLive = process.env.STRIPE_SECRET_KEY;
  const previousSandbox = process.env.STRIPE_SANDBOX_SECRET_KEY;
  const previousNextAuth = process.env.NEXTAUTH_URL;
  process.env.STRIPE_SECRET_KEY = "sk_live_unit_connect";
  process.env.STRIPE_SANDBOX_SECRET_KEY = "sk_test_sandbox_connect";
  process.env.NEXTAUTH_URL = "https://builder.example";
  t.after(() => {
    if (previousLive === undefined) delete process.env.STRIPE_SECRET_KEY;
    else process.env.STRIPE_SECRET_KEY = previousLive;
    if (previousSandbox === undefined) {
      delete process.env.STRIPE_SANDBOX_SECRET_KEY;
    } else {
      process.env.STRIPE_SANDBOX_SECRET_KEY = previousSandbox;
    }
    if (previousNextAuth === undefined) delete process.env.NEXTAUTH_URL;
    else process.env.NEXTAUTH_URL = previousNextAuth;
  });

  const auths: string[] = [];
  t.mock.method(globalThis, "fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    const auth = headers.get("Authorization");
    if (auth) auths.push(auth);
    const url = String(input);
    if (url.includes("/v2/core/accounts")) {
      return jsonResponse({ error: { message: "v2 unavailable" } }, 400);
    }
    if (url.includes("/v1/account_links")) {
      return jsonResponse({ url: "https://connect.stripe.com/setup/e/sbx" });
    }
    if (url.includes("/v1/accounts")) {
      if (init?.method === "POST") {
        return jsonResponse({ id: "acct_sandbox_onboard" });
      }
      return jsonResponse({
        id: "acct_sandbox_onboard",
        charges_enabled: false,
        payouts_enabled: false,
        details_submitted: false,
      });
    }
    return jsonResponse({ error: { message: `unexpected ${url}` } }, 500);
  });

  const result = await startMerchantConnect({
    clientId: app.clientId,
    userId: app.userId,
  });
  assert.equal(result.accountId, "acct_sandbox_onboard");
  assert.ok(auths.every((auth) => auth === "Bearer sk_test_sandbox_connect"));
  const config = await getAppBillingConfig(app.clientId);
  assert.equal(config?.stripeLivemode, false);
});

test("switchMerchantConnectPlane parks each plane and restores it on the way back", async (t) => {
  const app = await seedDeveloperAppWithClient({
    name: `StripePlaneSwap ${randomUUID().slice(0, 8)}`,
  });
  t.after(async () => {
    await cleanupTestApp(app);
  });

  const previousLive = process.env.STRIPE_SECRET_KEY;
  process.env.STRIPE_SECRET_KEY = "sk_live_unit_plane_swap";
  t.after(() => {
    if (previousLive === undefined) delete process.env.STRIPE_SECRET_KEY;
    else process.env.STRIPE_SECRET_KEY = previousLive;
  });
  // The restore path re-reads the account from Stripe; keep it off the network.
  t.mock.method(globalThis, "fetch", async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("/v1/accounts/acct_swap_live")) {
      return jsonResponse({
        id: "acct_swap_live",
        charges_enabled: true,
        payouts_enabled: true,
        details_submitted: true,
      });
    }
    return jsonResponse({ error: { message: `unexpected ${url}` } }, 500);
  });

  await upsertAppBillingConfig(app.clientId, {
    stripeLivemode: true,
    stripeConnectedAccountId: "acct_swap_live",
    stripeOnboardingMethod: "account_link",
    stripeChargesEnabled: true,
    stripePayoutsEnabled: true,
    stripeDetailsSubmitted: true,
    connectedAt: "2026-01-01T00:00:00.000Z",
  });

  // Live → sandbox. Sandbox was never onboarded, so the active plane clears.
  const toSandbox = await switchMerchantConnectPlane({
    clientId: app.clientId,
    livemode: false,
  });
  assert.deepEqual(toSandbox, {
    changed: true,
    livemode: false,
    accountId: null,
    ready: false,
  });
  const sandboxConfig = await getAppBillingConfig(app.clientId);
  assert.equal(sandboxConfig?.stripeLivemode, false);
  assert.equal(sandboxConfig?.stripeConnectedAccountId, null);
  assert.equal(sandboxConfig?.stripeChargesEnabled, false);

  // The live plane is parked, not discarded.
  const parkedLive = await getMerchantConnectPlane(app.clientId, true);
  assert.equal(parkedLive?.stripeConnectedAccountId, "acct_swap_live");
  assert.equal(parkedLive?.stripeChargesEnabled, true);
  assert.equal(parkedLive?.connectedAt, "2026-01-01T00:00:00.000Z");
  assert.equal(await getMerchantConnectPlane(app.clientId, false), null);

  // Sandbox → live restores the parked account without re-onboarding, and
  // re-reads its capabilities from Stripe rather than trusting parked flags.
  const backToLive = await switchMerchantConnectPlane({
    clientId: app.clientId,
    livemode: true,
  });
  assert.equal(backToLive.changed, true);
  assert.equal(backToLive.accountId, "acct_swap_live");
  assert.equal(backToLive.ready, true);
  const liveConfig = await getAppBillingConfig(app.clientId);
  assert.equal(liveConfig?.stripeLivemode, true);
  assert.equal(liveConfig?.stripeConnectedAccountId, "acct_swap_live");
  assert.equal(liveConfig?.stripeChargesEnabled, true);
  assert.equal(liveConfig?.connectedAt, "2026-01-01T00:00:00.000Z");

  // Re-selecting the active plane is a no-op, not a re-onboard.
  const again = await switchMerchantConnectPlane({
    clientId: app.clientId,
    livemode: true,
  });
  assert.equal(again.changed, false);
  assert.equal(again.accountId, "acct_swap_live");
});

test("an app user keeps a separate Stripe customer per plane", async (t) => {
  const app = await seedDeveloperAppWithClient({
    name: `StripePlaneCustomer ${randomUUID().slice(0, 8)}`,
  });
  t.after(async () => {
    await cleanupTestApp(app);
  });

  const externalUserId = `eu_${randomUUID().replaceAll("-", "")}`;
  await upsertAppUserStripeCustomer({
    clientId: app.clientId,
    externalUserId,
    stripeConnectedAccountId: "acct_plane_live",
    stripeCustomerId: "cus_live_side",
  });
  await upsertAppUserStripeCustomer({
    clientId: app.clientId,
    externalUserId,
    stripeConnectedAccountId: "acct_plane_sandbox",
    stripeCustomerId: "cus_sandbox_side",
  });

  const rows = await db
    .select()
    .from(appUserStripeCustomers)
    .where(
      and(
        eq(appUserStripeCustomers.clientId, app.clientId),
        eq(appUserStripeCustomers.externalUserId, externalUserId),
      ),
    );
  assert.equal(rows.length, 2, "both planes' customers coexist");

  // Each lookup resolves its own plane rather than whichever row came first.
  const live = await getAppUserStripeCustomer({
    clientId: app.clientId,
    externalUserId,
    stripeConnectedAccountId: "acct_plane_live",
  });
  assert.equal(live?.stripeCustomerId, "cus_live_side");
  const sandbox = await getAppUserStripeCustomer({
    clientId: app.clientId,
    externalUserId,
    stripeConnectedAccountId: "acct_plane_sandbox",
  });
  assert.equal(sandbox?.stripeCustomerId, "cus_sandbox_side");
  assert.equal(
    await getAppUserStripeCustomer({
      clientId: app.clientId,
      externalUserId,
      stripeConnectedAccountId: "acct_never_used",
    }),
    null,
  );
});
