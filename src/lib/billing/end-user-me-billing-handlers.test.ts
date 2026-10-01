import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { NextRequest } from "next/server";

import { db } from "@/db/index";
import { apiKeys } from "@/db/schema";
import {
  handleEndUserMeAllowancesGet,
  handleEndUserMeBillingStateGet,
  handleEndUserMeInvoiceHostedUrlGet,
  handleEndUserMeInvoicesGet,
  handleEndUserMePaymentMethodsGet,
  handleEndUserMeSubscriptionGet,
  handleEndUserMeWalletGet,
  handleEndUserMeWalletTransactionsGet,
  MERCHANT_BILLING_REQUIRED_CODE,
  OWNER_WALLET_NOT_APP_USER_CODE,
} from "@/lib/billing/end-user-me-billing-handlers";
import { upsertAppBillingConfig } from "@/lib/openmeter/billing-profiles";
import { hashToken } from "@/lib/token-hash";
import { test } from "@/test-utils/db-guard";
import {
  cleanupTestApp,
  createAppUser,
  seedDeveloperAppWithClient,
} from "@/test-utils/fixtures";

async function seedEndUserBearer(
  app: {
    clientId: string;
  },
  externalUserId = `user-${randomUUID()}`,
) {
  const appUser = await createAppUser({
    clientId: app.clientId,
    externalUserId,
  });
  const bare = `pmth_${randomUUID().replaceAll("-", "")}${"a".repeat(32)}`;
  await db.insert(apiKeys).values({
    id: `key-${randomUUID()}`,
    keyHash: hashToken(bare),
    clientId: app.clientId,
    appUserId: appUser.id,
    label: "end-user key",
    status: "active",
  });
  return { externalUserId, bare };
}

function meRequest(
  clientId: string,
  path: string,
  bearer?: string,
) {
  return new NextRequest(
    `http://localhost/api/v2/apps/${clientId}/me/billing/${path}`,
    bearer
      ? { headers: { Authorization: `Bearer ${bearer}` } }
      : undefined,
  );
}

test("me billing handlers 404 on blank client id", async () => {
  const request = meRequest(" ", "allowances");
  const res = await handleEndUserMeAllowancesGet(request, "  ");
  assert.equal(res.status, 404);
});

test("me billing money reads 403 on owner_rollup; invoices and PMs stay open", async (t) => {
  const app = await seedDeveloperAppWithClient({ status: "approved" });
  t.after(() => cleanupTestApp(app));
  const { bare } = await seedEndUserBearer(app);
  await upsertAppBillingConfig(app.clientId, { billingMode: "owner_rollup" });

  const money = [
    ["allowances", handleEndUserMeAllowancesGet],
    ["state", handleEndUserMeBillingStateGet],
    ["subscription", handleEndUserMeSubscriptionGet],
    ["wallet", handleEndUserMeWalletGet],
  ] as const;

  for (const [label, handler] of money) {
    const res = await handler(meRequest(app.clientId, label, bare), app.clientId);
    assert.equal(res.status, 403, label);
    const body = (await res.json()) as { code?: string };
    assert.equal(body.code, MERCHANT_BILLING_REQUIRED_CODE, label);
  }

  const invoices = await handleEndUserMeInvoicesGet(
    meRequest(app.clientId, "invoices", bare),
    app.clientId,
  );
  assert.equal(invoices.status, 200);
  const invoiceBody = (await invoices.json()) as {
    items: unknown[];
    page: number;
    pageSize: number;
    totalCount: number;
  };
  assert.deepEqual(invoiceBody.items, []);
  assert.equal(invoiceBody.totalCount, 0);

  const pms = await handleEndUserMePaymentMethodsGet(
    meRequest(app.clientId, "payment-methods", bare),
    app.clientId,
  );
  assert.equal(pms.status, 200);
  const pmBody = (await pms.json()) as { paymentMethods: unknown[] };
  assert.deepEqual(pmBody.paymentMethods, []);
});

test("me billing merchant wallet and allowances after OpenMeter-unset", async (t) => {
  const app = await seedDeveloperAppWithClient({ status: "approved" });
  t.after(() => cleanupTestApp(app));
  const { bare } = await seedEndUserBearer(app);
  await upsertAppBillingConfig(app.clientId, { billingMode: "merchant" });

  const wallet = await handleEndUserMeWalletGet(
    meRequest(app.clientId, "wallet", bare),
    app.clientId,
  );
  assert.equal(wallet.status, 200);
  const walletBody = (await wallet.json()) as {
    clientId: string;
    payPerUsePlans: unknown[];
    balance: unknown;
    degraded: boolean;
  };
  assert.equal(walletBody.clientId, app.clientId);
  assert.ok(Array.isArray(walletBody.payPerUsePlans));
  // OpenMeter is unreachable: balance is unknown, not zero.
  assert.equal(walletBody.balance, null);
  assert.equal(walletBody.degraded, true);

  const allowances = await handleEndUserMeAllowancesGet(
    meRequest(app.clientId, "allowances", bare),
    app.clientId,
  );
  assert.equal(allowances.status, 503);

  const state = await handleEndUserMeBillingStateGet(
    meRequest(app.clientId, "state", bare),
    app.clientId,
  );
  assert.equal(state.status, 200);
  assert.equal(state.headers.get("Cache-Control"), "no-store");

  const subscription = await handleEndUserMeSubscriptionGet(
    meRequest(app.clientId, "subscription", bare),
    app.clientId,
  );
  assert.equal(subscription.status, 200);
  const subBody = (await subscription.json()) as { subscription: unknown };
  assert.equal(subBody.subscription, null);
});

test("me billing rejects an owner credential that bills the owner wallet", async (t) => {
  const app = await seedDeveloperAppWithClient({ status: "approved" });
  t.after(() => cleanupTestApp(app));
  await upsertAppBillingConfig(app.clientId, { billingMode: "merchant" });
  // The app owner's own key: identity resolves to the platform owner wallet.
  const { bare } = await seedEndUserBearer(app, app.userId);

  for (const [label, call] of [
    ["wallet", () => handleEndUserMeWalletGet(meRequest(app.clientId, "wallet", bare), app.clientId)],
    ["payment-methods", () =>
      handleEndUserMePaymentMethodsGet(
        meRequest(app.clientId, "payment-methods", bare),
        app.clientId,
      )],
    ["invoices", () =>
      handleEndUserMeInvoicesGet(meRequest(app.clientId, "invoices", bare), app.clientId)],
  ] as const) {
    const res = await call();
    assert.equal(res.status, 403, label);
    const body = (await res.json()) as { code?: string };
    assert.equal(body.code, OWNER_WALLET_NOT_APP_USER_CODE, label);
  }
});

test("me billing wallet transactions and hosted-url are scoped to the Bearer subject", async (t) => {
  const app = await seedDeveloperAppWithClient({ status: "approved" });
  t.after(() => cleanupTestApp(app));
  const { bare } = await seedEndUserBearer(app);

  // owner_rollup: the ledger is a merchant money surface.
  const rollup = await handleEndUserMeWalletTransactionsGet(
    meRequest(app.clientId, "wallet/transactions", bare),
    app.clientId,
  );
  assert.equal(rollup.status, 403);
  assert.equal(
    ((await rollup.json()) as { code?: string }).code,
    MERCHANT_BILLING_REQUIRED_CODE,
  );

  const blank = await handleEndUserMeInvoiceHostedUrlGet(
    meRequest(app.clientId, "invoices/%20/hosted-url", bare),
    app.clientId,
    "%20",
  );
  assert.equal(blank.status, 400);

  const unauthenticated = await handleEndUserMeInvoiceHostedUrlGet(
    meRequest(app.clientId, "invoices/in_123/hosted-url"),
    app.clientId,
    "in_123",
  );
  assert.equal(unauthenticated.status, 401);
});

