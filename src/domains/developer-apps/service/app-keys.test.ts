import assert from "node:assert/strict";
import test from "node:test";

import { parseCreateAppKeyInput, parseDeleteAppKeyInput } from "./app-keys";

test("parseCreateAppKeyInput defaults invalid bodies", () => {
  const result = parseCreateAppKeyInput(null);
  assert.equal(result.ok, true);
  assert.deepEqual(result.ok ? result.value : null, {
    subscriptionId: null,
    label: null,
  });
});

test("parseCreateAppKeyInput reads optional fields", () => {
  const result = parseCreateAppKeyInput({
    subscriptionId: "sub_123",
    label: "Primary key",
  });
  assert.equal(result.ok, true);
  assert.deepEqual(result.ok ? result.value : null, {
    subscriptionId: "sub_123",
    label: "Primary key",
  });
});

test("parseDeleteAppKeyInput requires keyId", () => {
  const result = parseDeleteAppKeyInput(null);
  assert.equal(result.ok, false);
  assert.equal(result.ok ? "" : result.error, "keyId is required");
});
