import assert from "node:assert/strict";
import test from "node:test";

import {
  accumulateOwnerListMeterUsage,
  classifyOwnerListUsage,
  compareOwnersByUsageDesc,
  indexOwnerListMeterSubjects,
  ownerIdFromOwnerListMeterRow,
  ownerMatchesStatusFilter,
  parseOwnerListQuery,
} from "@/lib/billing/admin-owner-list";

test("parseOwnerListQuery defaults and clamps page size", () => {
  const parsed = parseOwnerListQuery(new URLSearchParams());
  assert.equal(parsed.q, "");
  assert.equal(parsed.page, 1);
  assert.equal(parsed.pageSize, 25);
  assert.equal(parsed.status, "all");
});

test("parseOwnerListQuery reads q, paging, and status", () => {
  const parsed = parseOwnerListQuery(
    new URLSearchParams("q=Daydream&page=2&pageSize=50&status=attention"),
  );
  assert.equal(parsed.q, "Daydream");
  assert.equal(parsed.page, 2);
  assert.equal(parsed.pageSize, 50);
  assert.equal(parsed.status, "attention");
});

test("parseOwnerListQuery ignores unknown status and oversize pageSize", () => {
  const parsed = parseOwnerListQuery(
    new URLSearchParams("status=nope&pageSize=999"),
  );
  assert.equal(parsed.status, "all");
  assert.equal(parsed.pageSize, 100);
});

test("parseOwnerListQuery rejects fractional page values and clamps huge pages", () => {
  const junk = parseOwnerListQuery(
    new URLSearchParams("page=2.9&pageSize=25junk"),
  );
  assert.equal(junk.page, 1);
  assert.equal(junk.pageSize, 25);

  const huge = parseOwnerListQuery(new URLSearchParams("page=99999"));
  assert.equal(huge.page, 10_000);
});

test("starter at or over included is blocked", () => {
  assert.equal(
    classifyOwnerListUsage({
      usedUsdMicros: 5_000_000n,
      includedUsdMicros: 5_000_000n,
      planKind: "starter",
    }).status,
    "blocked",
  );
  assert.equal(
    classifyOwnerListUsage({
      usedUsdMicros: 8_000_000n,
      includedUsdMicros: 5_000_000n,
      planKind: "starter",
    }).status,
    "blocked",
  );
});

test("starter under included is ok", () => {
  const result = classifyOwnerListUsage({
    usedUsdMicros: 1_000_000n,
    includedUsdMicros: 5_000_000n,
    planKind: "starter",
  });
  assert.equal(result.status, "ok");
  assert.equal(result.remainingUsdMicros, 4_000_000n);
  assert.equal(result.overageUsdMicros, 0n);
});

test("paid over included is overage, not blocked", () => {
  const result = classifyOwnerListUsage({
    usedUsdMicros: 25_000_000n,
    includedUsdMicros: 20_000_000n,
    planKind: "paid",
  });
  assert.equal(result.status, "overage");
  assert.equal(result.overageUsdMicros, 5_000_000n);
  assert.equal(result.remainingUsdMicros, 0n);
});

test("paid exactly at included is still ok", () => {
  assert.equal(
    classifyOwnerListUsage({
      usedUsdMicros: 20_000_000n,
      includedUsdMicros: 20_000_000n,
      planKind: "paid",
    }).status,
    "ok",
  );
});

test("zero used and zero included is ok rather than flagging everyone", () => {
  assert.equal(
    classifyOwnerListUsage({
      usedUsdMicros: 0n,
      includedUsdMicros: 0n,
      planKind: "starter",
    }).status,
    "ok",
  );
});

test("ownerMatchesStatusFilter attention is blocked or overage", () => {
  assert.equal(ownerMatchesStatusFilter("ok", "all"), true);
  assert.equal(ownerMatchesStatusFilter("ok", "attention"), false);
  assert.equal(ownerMatchesStatusFilter("blocked", "attention"), true);
  assert.equal(ownerMatchesStatusFilter("overage", "attention"), true);
  assert.equal(ownerMatchesStatusFilter("blocked", "blocked"), true);
  assert.equal(ownerMatchesStatusFilter("overage", "blocked"), false);
});

test("indexOwnerListMeterSubjects includes bare, owner:, and compound keys", () => {
  const ownerId = "owner-uuid-1";
  const index = indexOwnerListMeterSubjects(
    [ownerId],
    new Map([[ownerId, [{ id: "app_abc", name: "Demo" }]]]),
  );
  assert.equal(index.get(ownerId), ownerId);
  assert.equal(index.get(`owner:${ownerId}`), ownerId);
  assert.equal(index.get("app_abc:owner-uuid-1"), ownerId);
  assert.equal(index.get("app_abc:owner:owner-uuid-1"), ownerId);
});

test("ownerIdFromOwnerListMeterRow maps subject and external_user_id", () => {
  const ownerId = "owner-uuid-1";
  const index = indexOwnerListMeterSubjects([ownerId], new Map());
  assert.equal(
    ownerIdFromOwnerListMeterRow({ subject: ownerId, value: 1 }, index),
    ownerId,
  );
  assert.equal(
    ownerIdFromOwnerListMeterRow(
      { subject: null, value: 1, groupBy: { external_user_id: `owner:${ownerId}` } },
      index,
    ),
    ownerId,
  );
  assert.equal(
    ownerIdFromOwnerListMeterRow(
      { subject: "someone-else", value: 1, groupBy: { external_user_id: "eu-9" } },
      index,
    ),
    null,
  );
});

test("accumulateOwnerListMeterUsage sums fees and counts per owner", () => {
  const ownerA = "owner-a";
  const ownerB = "owner-b";
  const index = indexOwnerListMeterSubjects([ownerA, ownerB], new Map());
  const totals = accumulateOwnerListMeterUsage({
    feeRows: [
      { subject: ownerA, value: "100" },
      { groupBy: { external_user_id: ownerA }, value: "50" },
      { subject: ownerB, value: "7" },
    ],
    countRows: [
      { subject: ownerA, value: 3 },
      { subject: ownerB, value: 1 },
    ],
    subjectToOwnerId: index,
  });
  assert.equal(totals.get(ownerA)?.usedUsdMicros, "150");
  assert.equal(totals.get(ownerA)?.requestCount, 3);
  assert.equal(totals.get(ownerB)?.usedUsdMicros, "7");
  assert.equal(totals.get(ownerB)?.requestCount, 1);
});

test("compareOwnersByUsageDesc puts highest spend first", () => {
  const low = {
    id: "a",
    email: "a@example.test",
    cycleUsage: { usedUsdMicros: "100", includedUsdMicros: "1", remainingUsdMicros: "0", overageUsdMicros: "0", requestCount: 1 },
  };
  const high = {
    id: "b",
    email: "b@example.test",
    cycleUsage: { usedUsdMicros: "900", includedUsdMicros: "1", remainingUsdMicros: "0", overageUsdMicros: "0", requestCount: 1 },
  };
  assert.ok(compareOwnersByUsageDesc(high, low) < 0);
  assert.ok(compareOwnersByUsageDesc(low, high) > 0);
});
