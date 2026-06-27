import test from "node:test";
import assert from "node:assert/strict";

import { subscriptionRefMatches, toSubscriptionRef } from "./subscription-ref";

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

test("the opaque ref is NOT reversible to the raw OpenMeter id", () => {
  const ref = toSubscriptionRef(OPENMETER_ULID);
  assert.ok(ref);
  const token = ref.slice("subref_".length);
  // A base64url-decode of the token (the old, weak scheme) must NOT yield the id.
  const decodedUtf8 = Buffer.from(token, "base64url").toString("utf8");
  assert.notEqual(decodedUtf8, OPENMETER_ULID);
  assert.ok(!decodedUtf8.includes(OPENMETER_ULID));
  // And the id is not embedded in any hex/base64 view of the token either.
  assert.ok(!Buffer.from(token, "base64url").toString("hex").includes(
    Buffer.from(OPENMETER_ULID, "utf8").toString("hex"),
  ));
});

test("distinct internal ids map to distinct refs", () => {
  assert.notEqual(
    toSubscriptionRef(OPENMETER_ULID),
    toSubscriptionRef("01J8ZZZZZZZZZZZZZZZZZZZZZZ"),
  );
});

test("subscriptionRefMatches verifies a ref against the known internal id", () => {
  const ref = toSubscriptionRef(OPENMETER_ULID);
  assert.equal(subscriptionRefMatches(ref, OPENMETER_ULID), true);
  // Wrong candidate id does not match.
  assert.equal(subscriptionRefMatches(ref, "01J8ZZZZZZZZZZZZZZZZZZZZZZ"), false);
});

test("toSubscriptionRef returns null for empty/blank input", () => {
  assert.equal(toSubscriptionRef(null), null);
  assert.equal(toSubscriptionRef(undefined), null);
  assert.equal(toSubscriptionRef(""), null);
  assert.equal(toSubscriptionRef("   "), null);
});

test("subscriptionRefMatches rejects missing or malformed refs", () => {
  assert.equal(subscriptionRefMatches(null, OPENMETER_ULID), false);
  assert.equal(subscriptionRefMatches("", OPENMETER_ULID), false);
  assert.equal(subscriptionRefMatches("not-a-ref", OPENMETER_ULID), false);
  assert.equal(subscriptionRefMatches("subref_", OPENMETER_ULID), false);
  assert.equal(subscriptionRefMatches(toSubscriptionRef(OPENMETER_ULID), null), false);
});
