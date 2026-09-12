import assert from "node:assert/strict";
import test from "node:test";

import {
  clampDateRangeToMaxDays,
  isValidBoundedDateRange,
  MAX_DATE_RANGE_DAYS,
  parseUsageRequestDateRange,
} from "@/lib/billing-utils";

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
