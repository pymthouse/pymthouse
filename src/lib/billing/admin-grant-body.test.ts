import assert from "node:assert/strict";
import test from "node:test";

import { parseAdminGrantBody } from "@/lib/billing/admin-grant-body";

test("parseAdminGrantBody requires positive micros and a note", () => {
  assert.equal(parseAdminGrantBody(null).ok, false);
  assert.equal(parseAdminGrantBody({ amountUsdMicros: "0", note: "x" }).ok, false);
  assert.equal(
    parseAdminGrantBody({ amountUsdMicros: "100", note: "" }).ok,
    false,
  );
  const parsed = parseAdminGrantBody({
    amountUsdMicros: "1500000",
    note: "CS ticket",
    source: "promo",
  });
  assert.equal(parsed.ok, true);
  if (parsed.ok) {
    assert.equal(parsed.value.amountUsdMicros, 1_500_000n);
    assert.equal(parsed.value.source, "promo");
    assert.equal(parsed.value.note, "CS ticket");
  }
});

test("parseAdminGrantBody defaults source to manual", () => {
  const parsed = parseAdminGrantBody({
    amountUsdMicros: 10,
    note: "note",
  });
  assert.equal(parsed.ok, true);
  if (parsed.ok) {
    assert.equal(parsed.value.source, "manual");
  }
});

test("parseAdminGrantBody rejects unknown source", () => {
  const parsed = parseAdminGrantBody({
    amountUsdMicros: "10",
    note: "note",
    source: "moonpay",
  });
  assert.equal(parsed.ok, false);
});
