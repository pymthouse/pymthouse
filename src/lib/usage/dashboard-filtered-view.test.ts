import assert from "node:assert/strict";
import test from "node:test";

import type {
  BillingAppRow,
  BillingAppUsageSummary,
  BillingChartSeries,
  BillingUserUsageRow,
} from "@/lib/billing-usage-dashboard-data";
import {
  deriveFilteredView,
  historyClientIdsForView,
} from "@/lib/usage/dashboard-filtered-view";

function appRow(id: string): BillingAppRow {
  return {
    id,
    name: id,
    ownerId: "owner",
    ownerName: null,
    ownerEmail: null,
    publicClientId: id,
    usageKind: "tenant",
  };
}

function userRow(
  externalUserId: string,
  requestCount: number,
): BillingUserUsageRow {
  return {
    endUserId: externalUserId,
    externalUserId,
    userType: "system_managed",
    userLabel: externalUserId,
    identifier: externalUserId,
    requestCount,
    totalFeeWei: "0",
    totalUnits: "0",
    networkFeeUsdMicros: String(requestCount * 1000),
    byPipelineModel: [],
  };
}

function appUsage(
  appId: string,
  users: BillingUserUsageRow[],
): BillingAppUsageSummary {
  const requestCount = users.reduce((sum, u) => sum + u.requestCount, 0);
  return {
    app: appRow(appId),
    requestCount,
    totalFeeWei: "0",
    totalUnits: "0",
    networkFeeUsdMicros: "0",
    endUserBillableUsdMicros: "0",
    byUser: users,
    byPipelineModel: [],
  };
}

function series(
  appId: string,
  jobType: string,
): BillingChartSeries {
  return {
    appId,
    appName: appId,
    jobType,
    totalRequests: 1,
    points: [],
  };
}

const source = {
  orderedApps: [appRow("app_a"), appRow("app_b")],
  chartSeries: [series("app_a", "pipe/model"), series("app_b", "pipe/model")],
  chartSeriesByIdentity: [
    series("app_a", "eu_alpha"),
    series("app_a", "eu_beta"),
    series("app_b", "eu_alpha"),
  ],
  appUsage: [
    appUsage("app_a", [userRow("eu_alpha", 3), userRow("eu_beta", 2)]),
    appUsage("app_b", [userRow("eu_alpha", 1)]),
  ],
};

test("historyClientIdsForView omits ids for admin all-apps", () => {
  assert.deepEqual(
    historyClientIdsForView(true, "all", ["app_a", "app_b"], ["app_a", "app_b"]),
    [],
  );
  assert.deepEqual(
    historyClientIdsForView(true, "own", ["app_a", "app_b"], ["app_a", "app_b"]),
    ["app_a", "app_b"],
  );
  assert.deepEqual(
    historyClientIdsForView(false, "all", ["app_a", "app_b"], ["app_a"]),
    ["app_a"],
  );
});

test("deriveFilteredView leaves everything when all apps and identities are selected", () => {
  const derived = deriveFilteredView(
    source,
    ["app_a", "app_b"],
    "own",
    "pipeline",
    ["eu_alpha", "eu_beta"],
    ["eu_alpha", "eu_beta"],
  );
  assert.equal(derived.filteredSeries.length, 2);
  assert.equal(derived.filteredAppUsage.length, 2);
  assert.deepEqual(derived.historyClientIds, ["app_a", "app_b"]);
  assert.deepEqual(derived.historyIdentityIds, []);
});

test("deriveFilteredView narrows identity series and request history", () => {
  const derived = deriveFilteredView(
    source,
    ["app_a"],
    "own",
    "identity",
    ["eu_beta"],
    ["eu_alpha", "eu_beta"],
  );
  assert.deepEqual(
    derived.filteredSeries.map((s) => `${s.appId}:${s.jobType}`),
    ["app_a:eu_beta"],
  );
  assert.equal(derived.filteredAppUsage.length, 1);
  assert.deepEqual(
    derived.filteredAppUsage[0]?.byUser.map((u) => u.externalUserId),
    ["eu_beta"],
  );
  assert.equal(derived.filteredAppUsage[0]?.requestCount, 2);
  assert.deepEqual(derived.historyClientIds, ["app_a"]);
  assert.deepEqual(derived.historyIdentityIds, ["eu_beta"]);
});

test("deriveFilteredView returns empty series when no apps are selected", () => {
  const derived = deriveFilteredView(
    source,
    [],
    "own",
    "pipeline",
    ["eu_alpha", "eu_beta"],
    ["eu_alpha", "eu_beta"],
  );
  assert.deepEqual(derived.filteredSeries, []);
  assert.deepEqual(derived.filteredAppUsage, []);
  assert.deepEqual(derived.historyClientIds, []);
});
