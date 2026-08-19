import assert from "node:assert/strict";
import test from "node:test";

import {
  deviceVerificationError,
  parseDeviceVerificationInput,
} from "./device-verification";

test("parseDeviceVerificationInput validates required fields", () => {
  const result = parseDeviceVerificationInput({});
  assert.equal(result.ok, false);
  assert.equal(result.ok ? 0 : result.status, 400);
});

test("parseDeviceVerificationInput accepts supported actions", () => {
  const result = parseDeviceVerificationInput({ user_code: "abc", action: "approve" });
  assert.equal(result.ok, true);
  assert.equal(result.ok ? result.action : "", "approve");
});

test("deviceVerificationError shapes standard error body", () => {
  const result = deviceVerificationError("invalid_request", "bad");
  assert.deepEqual(result, {
    status: 400,
    body: { error: "invalid_request", error_description: "bad" },
  });
});
