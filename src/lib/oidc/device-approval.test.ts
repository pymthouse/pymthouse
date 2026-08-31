import test from "node:test";
import assert from "node:assert/strict";

import {
  isDeviceCodeBound,
  isDeviceCodeDenied,
  isDeviceCodeSettled,
} from "./device-approval";

test("isDeviceCodeBound is true when accountId is set", () => {
  assert.equal(isDeviceCodeBound({ accountId: "acct_1" }), true);
});

test("isDeviceCodeBound is true when grantId is set", () => {
  assert.equal(isDeviceCodeBound({ grantId: "g_1" }), true);
});

test("isDeviceCodeBound is false when unbound", () => {
  assert.equal(isDeviceCodeBound({}), false);
  assert.equal(isDeviceCodeBound({ accountId: "" }), false);
  assert.equal(isDeviceCodeBound({ grantId: "" }), false);
});

test("isDeviceCodeDenied is true when error is set", () => {
  assert.equal(isDeviceCodeDenied({ error: "access_denied" }), true);
});

test("isDeviceCodeDenied is false without a non-empty error", () => {
  assert.equal(isDeviceCodeDenied({}), false);
  assert.equal(isDeviceCodeDenied({ error: "" }), false);
  assert.equal(isDeviceCodeDenied({ error: null }), false);
  assert.equal(isDeviceCodeDenied({ accountId: "acct_1" }), false);
});

test("isDeviceCodeSettled treats deny and approve as terminal", () => {
  assert.equal(isDeviceCodeSettled({ error: "access_denied" }), true);
  assert.equal(isDeviceCodeSettled({ accountId: "acct_1" }), true);
  assert.equal(isDeviceCodeSettled({ grantId: "g_1" }), true);
  assert.equal(isDeviceCodeSettled({}), false);
});

test("denied DeviceCodes stay unbound but settled (cannot re-approve)", () => {
  const denied = { error: "access_denied", errorDescription: "denied" };
  assert.equal(isDeviceCodeBound(denied), false);
  assert.equal(isDeviceCodeDenied(denied), true);
  assert.equal(isDeviceCodeSettled(denied), true);
});
