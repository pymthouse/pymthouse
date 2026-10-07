import assert from "node:assert/strict";
import test from "node:test";

import {
  aggregateDailyUserRows,
  aggregateIdentityTotals,
} from "@/lib/openmeter/usage-read";

type Row = {
  value: number;
  windowStart?: Date;
  groupBy: Record<string, string>;
};

function rows(...items: Row[]) {
  return items as never;
}

test("aggregateIdentityTotals merges fee, count and duration per identity", () => {
  const result = aggregateIdentityTotals({
    clientId: "app_1",
    countRows: rows(
      { value: 10, groupBy: { client_id: "app_1", external_user_id: "u1" } },
      { value: 4, groupBy: { client_id: "app_1", external_user_id: "u2" } },
    ),
    feeRows: rows(
      { value: 655482, groupBy: { client_id: "app_1", external_user_id: "u1" } },
      { value: 1000, groupBy: { client_id: "app_1", external_user_id: "u2" } },
    ),
    billableSecsRows: rows(
      { value: 120, groupBy: { client_id: "app_1", external_user_id: "u1" } },
    ),
    dayCountRows: rows(),
  });

  const byId = new Map(result.map((r) => [r.externalUserId, r]));
  assert.equal(byId.get("u1")?.requestCount, 10);
  assert.equal(byId.get("u1")?.networkFeeUsdMicros, "655482");
  assert.equal(byId.get("u1")?.billableSecs, "120");
  assert.equal(byId.get("u2")?.requestCount, 4);
  // No duration rows for u2 — must default to zero, not drop the identity.
  assert.equal(byId.get("u2")?.billableSecs, "0");
});

test("aggregateIdentityTotals ignores rows from other apps", () => {
  const result = aggregateIdentityTotals({
    clientId: "app_1",
    countRows: rows(
      { value: 5, groupBy: { client_id: "app_1", external_user_id: "mine" } },
      { value: 99, groupBy: { client_id: "app_2", external_user_id: "theirs" } },
    ),
    feeRows: rows(),
    billableSecsRows: rows(),
    dayCountRows: rows(),
  });

  assert.equal(result.length, 1);
  assert.equal(result[0].externalUserId, "mine");
  assert.equal(result[0].requestCount, 5);
});

test("aggregateIdentityTotals derives last active from the latest non-zero day", () => {
  const result = aggregateIdentityTotals({
    clientId: "app_1",
    countRows: rows(),
    feeRows: rows(),
    billableSecsRows: rows(),
    dayCountRows: rows(
      {
        value: 3,
        windowStart: new Date("2026-07-10T00:00:00Z"),
        groupBy: { client_id: "app_1", external_user_id: "u1" },
      },
      {
        value: 1,
        windowStart: new Date("2026-07-22T00:00:00Z"),
        groupBy: { client_id: "app_1", external_user_id: "u1" },
      },
      // A later window with zero requests must not count as activity.
      {
        value: 0,
        windowStart: new Date("2026-07-29T00:00:00Z"),
        groupBy: { client_id: "app_1", external_user_id: "u1" },
      },
    ),
  });

  assert.equal(result.length, 1);
  assert.equal(result[0].lastActiveDate, "2026-07-22");
});

test("aggregateIdentityTotals returns null last-active when never seen", () => {
  const result = aggregateIdentityTotals({
    clientId: "app_1",
    countRows: rows({
      value: 2,
      groupBy: { client_id: "app_1", external_user_id: "u1" },
    }),
    feeRows: rows(),
    billableSecsRows: rows(),
    dayCountRows: rows(),
  });

  assert.equal(result[0].lastActiveDate, null);
});

test("aggregateIdentityTotals skips rows with no identity dimension", () => {
  const result = aggregateIdentityTotals({
    clientId: "app_1",
    countRows: rows({ value: 7, groupBy: { client_id: "app_1" } }),
    feeRows: rows(),
    billableSecsRows: rows(),
    dayCountRows: rows(),
  });

  assert.deepEqual(result, []);
});

test("aggregateDailyUserRows groups counts and fees by identity and day", () => {
  const result = aggregateDailyUserRows({
    clientId: "app_1",
    countRows: rows(
      {
        value: 3,
        windowStart: new Date("2026-07-01T00:00:00Z"),
        groupBy: { client_id: "app_1", external_user_id: "u1", pipeline: "byoc" },
      },
      {
        value: 2,
        windowStart: new Date("2026-07-01T00:00:00Z"),
        groupBy: { client_id: "app_1", external_user_id: "u1", pipeline: "other" },
      },
      {
        value: 5,
        windowStart: new Date("2026-07-02T00:00:00Z"),
        groupBy: { client_id: "app_1", external_user_id: "u2" },
      },
    ),
    feeRows: rows({
      value: 400,
      windowStart: new Date("2026-07-01T00:00:00Z"),
      groupBy: { client_id: "app_1", external_user_id: "u1", pipeline: "byoc" },
    }),
  });

  // u1's two pipeline rows collapse into a single identity+day row.
  assert.equal(result.length, 2);
  const first = result[0];
  assert.equal(first.externalUserId, "u1");
  assert.equal(first.date, "2026-07-01");
  assert.equal(first.requestCount, 5);
  assert.equal(first.networkFeeUsdMicros, "400");

  const u2 = result.find((r) => r.externalUserId === "u2");
  assert.equal(u2?.date, "2026-07-02");
  assert.equal(u2?.requestCount, 5);
});

test("aggregateDailyUserRows sorts by date then identity", () => {
  const result = aggregateDailyUserRows({
    clientId: "app_1",
    countRows: rows(
      {
        value: 1,
        windowStart: new Date("2026-07-03T00:00:00Z"),
        groupBy: { client_id: "app_1", external_user_id: "zeta" },
      },
      {
        value: 1,
        windowStart: new Date("2026-07-02T00:00:00Z"),
        groupBy: { client_id: "app_1", external_user_id: "beta" },
      },
      {
        value: 1,
        windowStart: new Date("2026-07-02T00:00:00Z"),
        groupBy: { client_id: "app_1", external_user_id: "alpha" },
      },
    ),
    feeRows: rows(),
  });

  assert.deepEqual(
    result.map((r) => `${r.date}:${r.externalUserId}`),
    ["2026-07-02:alpha", "2026-07-02:beta", "2026-07-03:zeta"],
  );
});

test("aggregateDailyUserRows filters to one actor", () => {
  const result = aggregateDailyUserRows({
    clientId: "app_1",
    filterExternalUserId: "alpha",
    countRows: rows(
      {
        value: 2,
        windowStart: new Date("2026-07-02T00:00:00Z"),
        groupBy: { client_id: "app_1", external_user_id: "alpha" },
      },
      {
        value: 9,
        windowStart: new Date("2026-07-02T00:00:00Z"),
        groupBy: { client_id: "app_1", external_user_id: "beta" },
      },
    ),
    feeRows: rows(),
  });
  assert.equal(result.length, 1);
  assert.equal(result[0]?.externalUserId, "alpha");
  assert.equal(result[0]?.requestCount, 2);
});
