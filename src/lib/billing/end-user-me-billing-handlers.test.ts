import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { NextRequest } from "next/server";

import { db } from "@/db/index";
import { apiKeys } from "@/db/schema";
import {
  handleEndUserMeAllowancesGet,
  handleEndUserMeBillingStateGet,
  handleEndUserMeInvoicesGet,
  handleEndUserMePaymentMethodsGet,
  handleEndUserMeSubscriptionGet,
  handleEndUserMeWalletGet,
  MERCHANT_BILLING_REQUIRED_CODE,
} from "@/lib/billing/end-user-me-billing-handlers";
import { upsertAppBillingConfig } from "@/lib/openmeter/billing-profiles";
import { hashToken } from "@/lib/token-hash";
import { test } from "@/test-utils/db-guard";
import {
  cleanupTestApp,
  createAppUser,
  seedDeveloperAppWithClient,
} from "@/test-utils/fixtures";

async function seedEndUserBearer(app: {
  clientId: string;
}) {
  const externalUserId = `user-${randomUUID()}`;
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
    `http://localhost/api/v1/apps/${clientId}/me/billing/${path}`,
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
  };
  assert.equal(walletBody.clientId, app.clientId);
  assert.ok(Array.isArray(walletBody.payPerUsePlans));

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
