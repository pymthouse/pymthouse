import assert from "node:assert/strict";
import test from "node:test";

import {
  PLATFORM_CONTROLLED_BILLING_FIELDS,
  platformControlledFieldsError,
  platformControlledFieldsInBody,
} from "@/lib/billing/platform-controlled-fields";

test("the platform reserves exactly the fee and the spend cap", () => {
  // Both constrain the app owner, so neither may be set on the owner path.
  assert.deepEqual([...PLATFORM_CONTROLLED_BILLING_FIELDS], [
    "applicationFeeBps",
    "endUserCap",
  ]);
});

test("detects a reserved field in a patch body", () => {
  assert.deepEqual(platformControlledFieldsInBody({ applicationFeeBps: 0 }), [
    "applicationFeeBps",
  ]);
  assert.deepEqual(platformControlledFieldsInBody({ endUserCap: 1_000_000 }), [
    "endUserCap",
  ]);
});

test("zero and other falsy values still count as attempts to set", () => {
  // Zeroing the platform fee is the exact abuse this guard exists for, so a
  // falsy value must not read as "absent".
  assert.deepEqual(platformControlledFieldsInBody({ applicationFeeBps: 0 }), [
    "applicationFeeBps",
  ]);
  assert.deepEqual(platformControlledFieldsInBody({ endUserCap: null }), [
    "endUserCap",
  ]);
});

test("revenue-rail fields are not reserved", () => {
  assert.deepEqual(
    platformControlledFieldsInBody({
      progressiveBilling: true,
      invoiceThresholdUsdMicros: "1000",
      billingMode: "merchant",
    }),
    [],
  );
});

test("an explicit undefined is treated as absent", () => {
  assert.deepEqual(
    platformControlledFieldsInBody({ applicationFeeBps: undefined }),
    [],
  );
});

test("reports both reserved fields together", () => {
  assert.deepEqual(
    platformControlledFieldsInBody({ endUserCap: 50, applicationFeeBps: 10 }),
    ["applicationFeeBps", "endUserCap"],
  );
});

test("error message reads correctly for one and for both fields", () => {
  assert.equal(
    platformControlledFieldsError(["applicationFeeBps"]),
    "applicationFeeBps is set by PymtHouse and cannot be changed here. Contact support to request a change.",
  );
  assert.equal(
    platformControlledFieldsError(["applicationFeeBps", "endUserCap"]),
    "applicationFeeBps and endUserCap are set by PymtHouse and cannot be changed here. Contact support to request a change.",
  );
});
