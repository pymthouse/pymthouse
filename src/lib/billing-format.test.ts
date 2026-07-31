import assert from "node:assert/strict";
import test from "node:test";

import { formatBillableDuration, formatCycleRange } from "@/lib/billing-format";

test("formatBillableDuration renders seconds, minutes and hours", () => {
  assert.equal(formatBillableDuration("45"), "45s");
  assert.equal(formatBillableDuration("312.5"), "5m 12s");
  assert.equal(formatBillableDuration("3600"), "1h 00m");
  assert.equal(formatBillableDuration("7205"), "2h 00m");
});

test("formatBillableDuration never shows metered work as zero", () => {
  // Sub-second billable time is still billable — must not read as "—".
  assert.equal(formatBillableDuration("0.4"), "<1s");
});

test("formatBillableDuration renders empty states for missing or zero input", () => {
  assert.equal(formatBillableDuration("0"), "—");
  assert.equal(formatBillableDuration(""), "—");
  assert.equal(formatBillableDuration(null), "—");
  assert.equal(formatBillableDuration(undefined), "—");
  assert.equal(formatBillableDuration("not-a-number"), "—");
  assert.equal(formatBillableDuration("-5"), "—");
});

test("formatCycleRange labels the timezone it rendered in", () => {
  const start = "2026-07-01T00:00:00.000Z";
  const end = "2026-07-31T23:59:59.999Z";

  const utc = formatCycleRange(start, end, { timeZone: "UTC" });
  assert.match(utc, /UTC$/, "the zone is named, not implied");
  assert.ok(utc.includes("Jul 1"), `expected Jul 1 in "${utc}"`);
  assert.ok(utc.includes("Jul 31"), `expected Jul 31 in "${utc}"`);
});

test("formatCycleRange renders the same instant differently per zone", () => {
  const start = "2026-07-01T00:00:00.000Z";
  const end = "2026-07-31T23:59:59.999Z";

  const utc = formatCycleRange(start, end, { timeZone: "UTC" });
  const newYork = formatCycleRange(start, end, { timeZone: "America/New_York" });

  // This divergence is exactly why the label is mandatory: without it these
  // read as two different cycles.
  assert.notEqual(utc, newYork);
  assert.ok(newYork.includes("Jun 30"), `expected Jun 30 in "${newYork}"`);
  assert.match(newYork, /EDT$/);
});

test("formatCycleRange is deterministic for a fixed zone", () => {
  const a = formatCycleRange("2026-07-01T00:00:00Z", "2026-07-31T23:59:59Z", {
    timeZone: "UTC",
  });
  const b = formatCycleRange("2026-07-01T00:00:00Z", "2026-07-31T23:59:59Z", {
    timeZone: "UTC",
  });
  assert.equal(a, b, "server and client must agree on the same input");
});

test("formatCycleRange falls back to raw values for unparseable input", () => {
  assert.equal(formatCycleRange("nope", "also-nope"), "nope — also-nope");
});
