import assert from "node:assert/strict";
import test from "node:test";
import type { OpenMeter } from "@openmeter/sdk";

import {
  __resetThresholdRaiseCacheForTests,
  evaluateAndRaiseGatheringInvoice,
  gatheringInvoiceMeetsThreshold,
  gatheringTotalUsdMicros,
  maybeRaiseThresholdInvoiceForIdentity,
} from "@/lib/billing/threshold-invoice-worker";
import {
  __testSetHostedOpenMeterClient,
  resetHostedOpenMeterClientForTests,
} from "@/lib/openmeter/client";
import { resetEnsuredCustomerCacheForTests } from "@/lib/openmeter/customers";
import { upsertAppBillingConfig } from "@/lib/openmeter/billing-profiles";
import { test as dbTest } from "@/test-utils/db-guard";
import { cleanupTestApp, seedDeveloperAppWithClient } from "@/test-utils/fixtures";

test("gatheringTotalUsdMicros covers edge branches", () => {
  assert.equal(gatheringTotalUsdMicros(undefined), null);
  assert.equal(gatheringTotalUsdMicros(Number.NaN), null);
  assert.equal(gatheringTotalUsdMicros(Number.POSITIVE_INFINITY), null);
  assert.equal(gatheringTotalUsdMicros("   "), null);
  assert.equal(gatheringTotalUsdMicros("12.34"), 12_340_000n);
  assert.equal(gatheringTotalUsdMicros("10"), 10_000_000n);
  assert.equal(gatheringTotalUsdMicros({} as unknown as string), null);
  assert.equal(gatheringTotalUsdMicros(true as unknown as string), null);
});

test("gatheringInvoiceMeetsThreshold ignores unparsable totals", () => {
  assert.equal(
    gatheringInvoiceMeetsThreshold(["nope", null, "3.00"], 5_000_000n),
    false,
  );
  assert.equal(
    gatheringInvoiceMeetsThreshold(["nope", "5.00"], 5_000_000n),
    true,
  );
});

test("evaluateAndRaiseGatheringInvoice raises when gathering total meets threshold", async () => {
  const raised: string[] = [];
  const outcome = await evaluateAndRaiseGatheringInvoice({
    customerId: "cust_1",
    thresholdUsdMicros: 5_000_000n,
    invoices: [
      { status: "draft", totals: { total: "99.00" } },
      { status: "gathering", totals: { total: "5.00" } },
    ],
    raise: async (customerId) => {
      raised.push(customerId);
    },
  });
  assert.equal(outcome, "raised");
  assert.deepEqual(raised, ["cust_1"]);
});

test("evaluateAndRaiseGatheringInvoice skips when no gathering invoices", async () => {
  let raiseCalls = 0;
  const outcome = await evaluateAndRaiseGatheringInvoice({
    customerId: "cust_2",
    thresholdUsdMicros: 1n,
    invoices: [{ status: "issued", totals: { total: "100.00" } }],
    raise: async () => {
      raiseCalls += 1;
    },
  });
  assert.equal(outcome, "skipped_no_gathering");
  assert.equal(raiseCalls, 0);
});

test("evaluateAndRaiseGatheringInvoice skips below threshold", async () => {
  let raiseCalls = 0;
  const outcome = await evaluateAndRaiseGatheringInvoice({
    customerId: "cust_3",
    thresholdUsdMicros: 10_000_000n,
    invoices: [{ status: "GATHERING", totals: { total: "2.00" } }],
    raise: async () => {
      raiseCalls += 1;
    },
  });
  assert.equal(outcome, "skipped_below_threshold");
  assert.equal(raiseCalls, 0);
});

test("maybeRaiseThresholdInvoiceForIdentity returns unavailable without OM", async () => {
  __resetThresholdRaiseCacheForTests();
  resetHostedOpenMeterClientForTests();
  __testSetHostedOpenMeterClient(null);
  const prevLive = process.env.OPENMETER_TEST_LIVE;
  delete process.env.OPENMETER_TEST_LIVE;
  try {
    const result = await maybeRaiseThresholdInvoiceForIdentity({
      clientId: "app_x",
      externalUserId: "eu_x",
    });
    assert.equal(result, "unavailable");
  } finally {
    if (prevLive === undefined) delete process.env.OPENMETER_TEST_LIVE;
    else process.env.OPENMETER_TEST_LIVE = prevLive;
    resetHostedOpenMeterClientForTests();
  }
});

dbTest("maybeRaiseThresholdInvoiceForIdentity raises once then rate-limits", async (t) => {
  __resetThresholdRaiseCacheForTests();
  const app = await seedDeveloperAppWithClient({ status: "approved" });
  t.after(async () => {
    await cleanupTestApp(app);
  });

  await upsertAppBillingConfig(app.clientId, {
    billingMode: "owner_rollup",
    invoiceThresholdUsdMicros: "5000000",
  });

  const prevLive = process.env.OPENMETER_TEST_LIVE;
  const prevUrl = process.env.OPENMETER_URL;
  const prevKey = process.env.OPENMETER_API_KEY;
  const prevMode = process.env.OPENMETER_ROUTE_MODE;
  const prevTtl = process.env.THRESHOLD_INVOICE_RAISE_TTL_SECONDS;
  process.env.OPENMETER_TEST_LIVE = "1";
  process.env.OPENMETER_URL = "http://127.0.0.1:48999";
  process.env.OPENMETER_ROUTE_MODE = "self_hosted";
  process.env.THRESHOLD_INVOICE_RAISE_TTL_SECONDS = "60";
  delete process.env.OPENMETER_API_KEY;
  resetHostedOpenMeterClientForTests();
  resetEnsuredCustomerCacheForTests();
  __resetThresholdRaiseCacheForTests();

  let invoicePendingCalls = 0;
  const ownerCustomer = {
    id: "om_owner_shared",
    key: app.userId,
    usageAttribution: { subjectKeys: [app.userId] },
  };
  const client = {
    customers: {
      get: async () => ownerCustomer,
      list: async () => ({ items: [ownerCustomer] }),
      update: async () => ownerCustomer,
      create: async () => {
        throw new Error("should reuse existing owner customer");
      },
    },
    billing: {
      invoices: {
        list: async () => ({
          items: [{ status: "gathering", totals: { total: "6.00" } }],
        }),
        invoicePendingLines: async () => {
          invoicePendingCalls += 1;
          return {};
        },
      },
    },
  } as unknown as OpenMeter;

  __testSetHostedOpenMeterClient(client);
  t.after(() => {
    if (prevLive === undefined) delete process.env.OPENMETER_TEST_LIVE;
    else process.env.OPENMETER_TEST_LIVE = prevLive;
    if (prevUrl === undefined) delete process.env.OPENMETER_URL;
    else process.env.OPENMETER_URL = prevUrl;
    if (prevKey === undefined) delete process.env.OPENMETER_API_KEY;
    else process.env.OPENMETER_API_KEY = prevKey;
    if (prevMode === undefined) delete process.env.OPENMETER_ROUTE_MODE;
    else process.env.OPENMETER_ROUTE_MODE = prevMode;
    if (prevTtl === undefined) delete process.env.THRESHOLD_INVOICE_RAISE_TTL_SECONDS;
    else process.env.THRESHOLD_INVOICE_RAISE_TTL_SECONDS = prevTtl;
    resetHostedOpenMeterClientForTests();
    resetEnsuredCustomerCacheForTests();
    __resetThresholdRaiseCacheForTests();
  });

  const first = await maybeRaiseThresholdInvoiceForIdentity({
    clientId: app.clientId,
    externalUserId: `owner:${app.userId}`,
  });
  assert.equal(first, "raised");
  assert.equal(invoicePendingCalls, 1);

  const second = await maybeRaiseThresholdInvoiceForIdentity({
    clientId: app.clientId,
    externalUserId: `owner:${app.userId}`,
  });
  assert.equal(second, "rate_limited");
  assert.equal(invoicePendingCalls, 1);
});
