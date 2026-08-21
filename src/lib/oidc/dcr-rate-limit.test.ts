import assert from "node:assert/strict";
import test from "node:test";

import {
  consumeDcrRegistrationSlot,
  dcrRegistrationClientKey,
  resetDcrRegistrationRateLimitForTests,
} from "@/lib/oidc/dcr-rate-limit";

test("dcrRegistrationClientKey prefers the first forwarded hop", () => {
  assert.equal(
    dcrRegistrationClientKey(
      new Headers({ "x-forwarded-for": "203.0.113.9, 10.0.0.1" }),
    ),
    "203.0.113.9",
  );
});

test("consumeDcrRegistrationSlot rate-limits a client key", () => {
  resetDcrRegistrationRateLimitForTests();
  for (let i = 0; i < 10; i += 1) {
    assert.equal(consumeDcrRegistrationSlot("203.0.113.9"), true);
  }
  assert.equal(consumeDcrRegistrationSlot("203.0.113.9"), false);
  assert.equal(consumeDcrRegistrationSlot("198.51.100.2"), true);
});
