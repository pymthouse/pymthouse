import test from "node:test";
import assert from "node:assert/strict";

import { fromSubscriptionRef, toSubscriptionRef } from "./subscription-ref";

const OPENMETER_ULID = "01J8ZQ9X7K6M3N2P4R5S6T7U8V";

test("toSubscriptionRef produces a neutral, opaque, prefixed token", () => {
  const ref = toSubscriptionRef(OPENMETER_ULID);
  assert.ok(ref);
  assert.match(ref, /^subref_/);
  // The raw OpenMeter id must not be observable in the neutral ref.
  assert.ok(!ref.includes(OPENMETER_ULID));
  assert.ok(!ref.toLowerCase().includes("openmeter"));
});

test("toSubscriptionRef is deterministic / stable", () => {
  assert.equal(toSubscriptionRef(OPENMETER_ULID), toSubscriptionRef(OPENMETER_ULID));
});

test("subscriptionRef round-trips back to the internal id", () => {
  const ref = toSubscriptionRef(OPENMETER_ULID);
  assert.equal(fromSubscriptionRef(ref), OPENMETER_ULID);
});

test("toSubscriptionRef returns null for empty/blank input", () => {
  assert.equal(toSubscriptionRef(null), null);
  assert.equal(toSubscriptionRef(undefined), null);
  assert.equal(toSubscriptionRef(""), null);
  assert.equal(toSubscriptionRef("   "), null);
});

test("fromSubscriptionRef rejects missing or malformed refs", () => {
  assert.equal(fromSubscriptionRef(null), null);
  assert.equal(fromSubscriptionRef(""), null);
  assert.equal(fromSubscriptionRef("not-a-ref"), null);
  assert.equal(fromSubscriptionRef("subref_"), null);
});
