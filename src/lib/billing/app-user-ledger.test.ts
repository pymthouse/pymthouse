import assert from "node:assert/strict";
import test from "node:test";

import { loadAppUserBillingLedger } from "./app-user-ledger";

type AppUserLedgerDeps = NonNullable<Parameters<typeof loadAppUserBillingLedger>[1]>;

function createDeps(overrides: Partial<AppUserLedgerDeps> = {}): AppUserLedgerDeps {
  return {
    resolveOpenMeterMeterClientId: async () => "pc_test",
    listAppUserCreditGrants: async () => [],
    getPlanDiscountUsdMicros: async () => ({
      totalUsdMicros: 0n,
      remainingUsdMicros: 0n,
    }),
    getTrialCreditBalance: async () =>
      ({
        balanceUsdMicros: "0",
      }) as Awaited<ReturnType<AppUserLedgerDeps["getTrialCreditBalance"]>>,
    listMerchantConnectInvoicesForAppUser: async () => ({
      items: [],
      page: 1,
      pageSize: 50,
      totalCount: 0,
    }),
    isHostedAdminClientAvailable: () => false,
    getHostedAdminClient: () =>
      ({}) as ReturnType<AppUserLedgerDeps["getHostedAdminClient"]>,
    querySubjectDailyFeeUsage: async () => [],
    ...overrides,
  };
}

test("loadAppUserBillingLedger short-circuits when identifiers are blank", async () => {
  let called = false;
  const deps = createDeps({
    resolveOpenMeterMeterClientId: async () => {
      called = true;
      return "pc_test";
    },
  });

  const result = await loadAppUserBillingLedger(
    {
      appId: "app_1",
      publicClientId: "   ",
      externalUserId: "external_1",
    },
    deps,
  );

  assert.deepEqual(result, { items: [], degraded: false });
  assert.equal(called, false);
});

test("loadAppUserBillingLedger marks degraded when history is truncated", async () => {
  const deps = createDeps({
    listAppUserCreditGrants: async () => [
      {
        id: "grant_1",
        amountUsdMicros: "1000000",
        date: "2026-01-01T00:00:00.000Z",
        name: "Top-up",
      },
    ],
    listMerchantConnectInvoicesForAppUser: async () => ({
      items: [
        {
          id: "inv_1",
          number: "INV-1",
          status: "paid",
          currency: "usd",
          totalAmount: "5.00",
          issuedAt: "2026-01-02T00:00:00.000Z",
          periodStart: "2026-01-01T00:00:00.000Z",
          periodEnd: "2026-01-31T23:59:59.000Z",
          invoiceType: "stripe_connect",
        },
      ],
      page: 1,
      pageSize: 50,
      totalCount: 2,
    }),
    isHostedAdminClientAvailable: () => true,
    querySubjectDailyFeeUsage: async () => [],
  });

  const result = await loadAppUserBillingLedger(
    {
      appId: "app_1",
      publicClientId: "pc_test",
      externalUserId: "external_1",
    },
    deps,
  );

  assert.equal(result.degraded, true);
  assert.ok(result.items.some((item) => item.type === "invoice"));
});

test("loadAppUserBillingLedger marks degraded when meter query reports fallback", async () => {
  const deps = createDeps({
    isHostedAdminClientAvailable: () => true,
    querySubjectDailyFeeUsage: async (input) => {
      input.onDegraded?.();
      return [{ date: "2026-01-03", usedUsdMicros: "250000" }];
    },
  });

  const result = await loadAppUserBillingLedger(
    {
      appId: "app_1",
      publicClientId: "pc_test",
      externalUserId: "external_1",
    },
    deps,
  );

  assert.equal(result.degraded, true);
  assert.ok(
    result.items.some(
      (item) => item.type === "usage" && item.amountUsdMicros === "250000",
    ),
  );
});
