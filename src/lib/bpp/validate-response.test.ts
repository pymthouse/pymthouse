import test from "node:test";
import assert from "node:assert/strict";

import { buildValidateResponseBody } from "./validate-response";
import { fromSubscriptionRef } from "./subscription-ref";

const OPENMETER_ULID = "01J8ZQ9X7K6M3N2P4R5S6T7U8V";

/**
 * OpenMeter-internal IDENTIFIER names that must never cross the ② seam. Scope of
 * this PR is the OM-identifier leak; `client_id`/`allowedModels` are pre-existing
 * neutral public fields preserved for zero-regression (the full ② reshape to
 * user.sub/billing_account/`pipeline:model` is tracked separately as PYMT-3).
 */
const OPENMETER_INTERNAL_IDS = ["openmeter_subscription_id", "openmeter_customer_id"];

function assertNoOpenMeterIdentifierLeak(body: Record<string, unknown>): void {
  for (const key of Object.keys(body)) {
    assert.ok(!OPENMETER_INTERNAL_IDS.includes(key), `unexpected OM id key: ${key}`);
    assert.ok(!key.toLowerCase().startsWith("openmeter"), `unexpected openmeter* key: ${key}`);
  }
  for (const value of Object.values(body)) {
    if (typeof value === "string") {
      assert.ok(!value.includes(OPENMETER_ULID), "raw OpenMeter id leaked as a value");
    }
  }
}

test("validate response never leaks OpenMeter-internal identifiers", () => {
  const body = buildValidateResponseBody({
    clientId: "app_123",
    plan: { id: "pro", name: "Pro" },
    allowedModels: ["sdxl", "ltx"],
    openmeterSubscriptionId: OPENMETER_ULID,
  });
  assertNoOpenMeterIdentifierLeak(body);
  assert.ok(!("openmeter_subscription_id" in body));
});

test("validate response surfaces a neutral subscriptionRef when a subscription resolves", () => {
  const body = buildValidateResponseBody({
    clientId: "app_123",
    plan: null,
    allowedModels: [],
    openmeterSubscriptionId: OPENMETER_ULID,
  });
  assert.equal(typeof body.subscriptionRef, "string");
  const ref = body.subscriptionRef as string;
  assert.match(ref, /^subref_/);
  assert.ok(!ref.includes(OPENMETER_ULID));
  // Provider can still decode its own opaque ref.
  assert.equal(fromSubscriptionRef(ref), OPENMETER_ULID);
});

test("validate response omits subscriptionRef for free/no-subscription keys", () => {
  const body = buildValidateResponseBody({
    clientId: "app_123",
    plan: null,
    allowedModels: [],
  });
  assert.ok(!("subscriptionRef" in body));
});

test("validate response preserves the existing neutral fields (zero regression)", () => {
  const body = buildValidateResponseBody({
    clientId: "app_123",
    plan: { id: "pro" },
    allowedModels: ["sdxl"],
    openmeterSubscriptionId: OPENMETER_ULID,
  });
  assert.equal(body.valid, true);
  assert.equal(body.client_id, "app_123");
  assert.deepEqual(body.plan, { id: "pro" });
  assert.deepEqual(body.allowedModels, ["sdxl"]);
});
