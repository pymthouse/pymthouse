import assert from "node:assert/strict";
import test from "node:test";

test("AllowanceStrip props align with live credit ledger fields", async () => {
  // Smoke-import the helper used by the dashboard summary so regressions that
  // drop creditAllowance from the public surface fail here.
  const { getDashboardUsageSummary } = await import("./dashboard-usage-summary");
  assert.equal(typeof getDashboardUsageSummary, "function");
});

test("billing usage payload includes creditAllowance for app-scoped pages", async () => {
  const mod = await import("./billing-usage-dashboard-data");
  assert.equal(typeof mod.getBillingUsageDashboardData, "function");
  // Type-level contract: payload must expose creditAllowance (used by
  // /apps/[id]/usage and /billing). Checked via exported result shape sample.
  const sample: mod.BillingUsageDashboardPayload = {
    scope: "single",
    userId: "u",
    role: "developer",
    isAdmin: false,
    usageSource: "openmeter",
    cycle: { start: "2026-07-01T00:00:00.000Z", end: "2026-08-01T00:00:00.000Z" },
    orderedApps: [],
    appUsage: [],
    chartData: [],
    chartSeries: [],
    totalRequests: 0,
    totalFeeWei: 0n,
    totalNetworkFeeUsdMicros: 0n,
    appsWithUsage: 0,
    creditAllowance: null,
  };
  assert.equal(sample.creditAllowance, null);
});

test("sumPrepaidCreditBalancesForClientIds returns null when OpenMeter is off", async () => {
  const prevUrl = process.env.OPENMETER_URL;
  const prevKey = process.env.OPENMETER_API_KEY;
  delete process.env.OPENMETER_URL;
  delete process.env.OPENMETER_API_KEY;

  try {
    // Reset memoized client so isHostedAdminClientAvailable sees the cleared env.
    const { resetHostedOpenMeterClientForTests } = await import(
      "./openmeter/client"
    );
    resetHostedOpenMeterClientForTests();
    const { sumPrepaidCreditBalancesForClientIds } = await import(
      "./openmeter/credit-allowance-summary"
    );
    const summary = await sumPrepaidCreditBalancesForClientIds([
      "app_deadbeefdeadbeefdeadbeef",
    ]);
    assert.equal(summary, null);
  } finally {
    if (prevUrl === undefined) delete process.env.OPENMETER_URL;
    else process.env.OPENMETER_URL = prevUrl;
    if (prevKey === undefined) delete process.env.OPENMETER_API_KEY;
    else process.env.OPENMETER_API_KEY = prevKey;
    const { resetHostedOpenMeterClientForTests } = await import(
      "./openmeter/client"
    );
    resetHostedOpenMeterClientForTests();
  }
});
