import assert from "node:assert/strict";
import test from "node:test";

import { parseOwnerBillingPatchBody } from "@/lib/billing/owner-billing-patch";

test("parseOwnerBillingPatchBody accepts sparse valid fields", () => {
  const parsed = parseOwnerBillingPatchBody({
    starterIncludedUsdMicros: "5000000",
    endUserCap: 40,
    note: "design partner",
  });
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  assert.deepEqual(parsed.patch, {
    starterIncludedUsdMicros: "5000000",
    endUserCap: 40,
    note: "design partner",
  });
});

test("parseOwnerBillingPatchBody clears fields with null", () => {
  const parsed = parseOwnerBillingPatchBody({
    starterIncludedUsdMicros: null,
    endUserCap: null,
    note: null,
  });
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  assert.deepEqual(parsed.patch, {
    starterIncludedUsdMicros: null,
    endUserCap: null,
    note: null,
  });
});

test("parseOwnerBillingPatchBody rejects applicationFeeBps and bad fields", () => {
  assert.equal(parseOwnerBillingPatchBody({}).ok, false);
  assert.equal(parseOwnerBillingPatchBody({ starterIncludedUsdMicros: "x" }).ok, false);
  assert.equal(parseOwnerBillingPatchBody({ endUserCap: 0 }).ok, false);
  assert.equal(parseOwnerBillingPatchBody({ note: 1 }).ok, false);
  const fee = parseOwnerBillingPatchBody({ applicationFeeBps: 250 });
  assert.equal(fee.ok, false);
  if (!fee.ok) {
    assert.match(fee.error, /applicationFeeBps is not an owner override/);
  }
});
