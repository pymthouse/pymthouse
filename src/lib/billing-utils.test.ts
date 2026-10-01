import assert from "node:assert/strict";
import test from "node:test";

import {
  BILLING_CYCLE_LOOKBACK_MONTHS,
  billingCycleSelectOptions,
  calendarMonthBoundsForYearMonth,
  calendarMonthBoundsUtc,
  clampDateRangeToMaxDays,
  formatBillingCycleMonthLabel,
  invoiceOverlapsCycle,
  isValidBoundedDateRange,
  billingCycleHref,
  listBillingCycleKeysSince,
  listRecentBillingCycleKeys,
  MAX_DATE_RANGE_DAYS,
  parseUsageRequestDateRange,
  resolveBillingCycle,
  utcYearMonthKey,
} from "@/lib/billing-utils";

const NOW = new Date("2026-09-15T12:00:00.000Z");

test("utcYearMonthKey is UTC YYYY-MM", () => {
  assert.equal(utcYearMonthKey(NOW), "2026-09");
  assert.equal(utcYearMonthKey(new Date("2026-01-01T00:00:00.000Z")), "2026-01");
});

test("calendarMonthBoundsForYearMonth matches calendarMonthBoundsUtc", () => {
  const fromKey = calendarMonthBoundsForYearMonth("2026-07");
  assert.ok(fromKey);
  assert.deepEqual(fromKey, calendarMonthBoundsUtc(new Date("2026-07-15T00:00:00.000Z")));
});

test("calendarMonthBoundsForYearMonth rejects malformed keys", () => {
  assert.equal(calendarMonthBoundsForYearMonth("2026-13"), null);
  assert.equal(calendarMonthBoundsForYearMonth("2026-7"), null);
  assert.equal(calendarMonthBoundsForYearMonth("july"), null);
  assert.equal(calendarMonthBoundsForYearMonth(""), null);
});

test("resolveBillingCycle falls back to the current UTC month", () => {
  const current = resolveBillingCycle(null, NOW);
  assert.equal(current.key, "2026-09");
  assert.equal(current.isCurrent, true);

  const malformed = resolveBillingCycle("nope", NOW);
  assert.equal(malformed.key, "2026-09");
  assert.equal(malformed.isCurrent, true);

  const future = resolveBillingCycle("2026-10", NOW);
  assert.equal(future.key, "2026-09");
  assert.equal(future.isCurrent, true);
});

test("resolveBillingCycle accepts a prior UTC month", () => {
  const july = resolveBillingCycle("2026-07", NOW);
  assert.equal(july.key, "2026-07");
  assert.equal(july.isCurrent, false);
  assert.equal(july.start, "2026-07-01T00:00:00.000Z");
  assert.equal(july.end, "2026-07-31T23:59:59.999Z");
});

test("listRecentBillingCycleKeys is newest-first and includes the current month", () => {
  const keys = listRecentBillingCycleKeys(NOW, 3);
  assert.deepEqual(keys, ["2026-09", "2026-08", "2026-07"]);
  assert.equal(listRecentBillingCycleKeys(NOW).length, BILLING_CYCLE_LOOKBACK_MONTHS);
});

test("formatBillingCycleMonthLabel uses a long UTC month name", () => {
  assert.equal(formatBillingCycleMonthLabel("2026-07"), "July 2026");
  assert.equal(formatBillingCycleMonthLabel("bad"), "bad");
});

test("listBillingCycleKeysSince starts at the first month with usage", () => {
  const keys = listBillingCycleKeysSince("2026-08", NOW, 4);
  assert.deepEqual(keys, ["2026-09", "2026-08"]);
});

test("listBillingCycleKeysSince keeps the full lookback when earliest is unknown", () => {
  assert.deepEqual(
    listBillingCycleKeysSince(null, NOW, 2),
    listRecentBillingCycleKeys(NOW, 2),
  );
});

test("billingCycleHref omits cycle on the current month", () => {
  assert.equal(billingCycleHref("/billing", "2026-09-01T00:00:00.000Z", NOW), "/billing");
  assert.equal(
    billingCycleHref("/usage", "2026-07-01T00:00:00.000Z", NOW),
    "/usage?cycle=2026-07",
  );
});

test("billingCycleSelectOptions keeps a bookmarked month that fell off the lookback", () => {
  const options = billingCycleSelectOptions({
    selectedKey: "2025-01",
    now: NOW,
    count: 2,
  });
  assert.deepEqual(
    options.map((option) => option.key),
    ["2026-09", "2026-08", "2025-01"],
  );
  assert.equal(options[0]?.isCurrent, true);
  assert.equal(options[2]?.isCurrent, false);
});

test("billingCycleSelectOptions drops months before usage began", () => {
  const options = billingCycleSelectOptions({
    selectedKey: "2026-09",
    now: NOW,
    count: 4,
    earliestKey: "2026-08",
  });
  assert.deepEqual(
    options.map((option) => option.key),
    ["2026-09", "2026-08"],
  );
});

test("invoiceOverlapsCycle uses the billing period when present", () => {
  const july = resolveBillingCycle("2026-07", NOW);
  assert.equal(
    invoiceOverlapsCycle(
      {
        periodStart: "2026-07-01T00:00:00.000Z",
        periodEnd: "2026-07-31T23:59:59.999Z",
        issuedAt: "2026-08-02T00:00:00.000Z",
      },
      july,
    ),
    true,
  );
  assert.equal(
    invoiceOverlapsCycle(
      {
        periodStart: "2026-06-01T00:00:00.000Z",
        periodEnd: "2026-06-30T23:59:59.999Z",
      },
      july,
    ),
    false,
  );
});

test("invoiceOverlapsCycle falls back to issuedAt", () => {
  const july = resolveBillingCycle("2026-07", NOW);
  assert.equal(
    invoiceOverlapsCycle({ issuedAt: "2026-07-15T12:00:00.000Z" }, july),
    true,
  );
  assert.equal(
    invoiceOverlapsCycle({ issuedAt: "2026-08-01T00:00:00.000Z" }, july),
    false,
  );
  assert.equal(invoiceOverlapsCycle({}, july), false);
});

test("isValidBoundedDateRange accepts a span of MAX_DATE_RANGE_DAYS", () => {
  assert.equal(
    isValidBoundedDateRange(
      "2025-09-10T00:00:00.000Z",
      "2026-09-09T15:53:00.000Z",
    ),
    true,
  );
});

test("isValidBoundedDateRange rejects epoch to now", () => {
  assert.equal(
    isValidBoundedDateRange(
      "1970-01-01T00:00:00.000Z",
      "2026-09-09T15:53:00.000Z",
    ),
    false,
  );
});

test("clampDateRangeToMaxDays shortens epoch to now from the start", () => {
  const to = "2026-09-09T15:53:00.000Z";
  const clamped = clampDateRangeToMaxDays("1970-01-01T00:00:00.000Z", to);
  assert.ok(clamped);
  assert.equal(clamped.to, to);
  assert.equal(clamped.from, "2025-09-10T00:00:00.000Z");
  assert.equal(isValidBoundedDateRange(clamped.from, clamped.to), true);
});

test("clampDateRangeToMaxDays leaves a valid range unchanged", () => {
  const from = "2026-09-01T00:00:00.000Z";
  const to = "2026-09-09T15:53:00.000Z";
  assert.deepEqual(clampDateRangeToMaxDays(from, to), { from, to });
});

test("clampDateRangeToMaxDays returns null when from is after to", () => {
  assert.equal(
    clampDateRangeToMaxDays(
      "2026-09-10T00:00:00.000Z",
      "2026-09-09T00:00:00.000Z",
    ),
    null,
  );
});

test("parseUsageRequestDateRange requires both bounds together", () => {
  const onlyFrom = parseUsageRequestDateRange("2026-09-01T00:00:00.000Z", null);
  assert.equal(onlyFrom.ok, false);
  if (!onlyFrom.ok) {
    assert.match(onlyFrom.error, /together/);
  }
});

test("parseUsageRequestDateRange omits bounds when both are empty", () => {
  assert.deepEqual(parseUsageRequestDateRange(null, null), { ok: true });
});

test("parseUsageRequestDateRange rejects oversize ranges unless clamped", () => {
  const rejected = parseUsageRequestDateRange(
    "1970-01-01T00:00:00.000Z",
    "2026-09-09T15:53:00.000Z",
  );
  assert.equal(rejected.ok, false);
  if (!rejected.ok) {
    assert.match(rejected.error, new RegExp(String(MAX_DATE_RANGE_DAYS)));
  }

  const clamped = parseUsageRequestDateRange(
    "1970-01-01T00:00:00.000Z",
    "2026-09-09T15:53:00.000Z",
    { clampOversize: true },
  );
  assert.deepEqual(clamped, {
    ok: true,
    from: "2025-09-10T00:00:00.000Z",
    to: "2026-09-09T15:53:00.000Z",
  });
});
