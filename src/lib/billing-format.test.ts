import assert from "node:assert/strict";
import test from "node:test";

import { formatBillableDuration } from "@/lib/billing-format";

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
