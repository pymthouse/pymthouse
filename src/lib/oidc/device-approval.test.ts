import test from "node:test";
import assert from "node:assert/strict";

import { isDeviceCodeBound } from "./device-approval";

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
