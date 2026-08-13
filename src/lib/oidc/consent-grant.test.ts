import assert from "node:assert/strict";

import { test } from "node:test";

import { asOidcAccountId } from "./consent-grant";

test("asOidcAccountId accepts non-empty strings", () => {
  assert.equal(asOidcAccountId("user-1"), "user-1");
  assert.equal(asOidcAccountId("  abc  "), "abc");
});

test("asOidcAccountId rejects values that would crash session.loginAccount", () => {
  assert.equal(asOidcAccountId(undefined), null);
  assert.equal(asOidcAccountId(null), null);
  assert.equal(asOidcAccountId(""), null);
  assert.equal(asOidcAccountId("   "), null);
  assert.equal(asOidcAccountId(123), null);
});
