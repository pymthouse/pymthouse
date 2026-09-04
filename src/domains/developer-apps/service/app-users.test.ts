import assert from "node:assert/strict";
import test from "node:test";

import {
  parseCreateAppUserInput,
  parseDeleteAppUserInput,
  parseUpdateAppUserInput,
} from "./app-users";

test("parseCreateAppUserInput requires externalUserId", () => {
  const result = parseCreateAppUserInput({});
  assert.equal(result.ok, false);
  assert.equal(result.ok ? "" : result.error, "externalUserId is required");
});

test("parseCreateAppUserInput normalizes optional fields", () => {
  const result = parseCreateAppUserInput({
    externalUserId: " ext-1 ",
    email: " user@example.com ",
  });
  assert.equal(result.ok, true);
  assert.deepEqual(result.ok ? result.value : null, {
    externalUserId: "ext-1",
    email: "user@example.com",
    hasEmail: true,
    status: "active",
    hasStatus: false,
  });
});

test("parseUpdateAppUserInput preserves field presence flags", () => {
  const result = parseUpdateAppUserInput({
    externalUserId: " ext-2 ",
    status: "inactive",
  });
  assert.equal(result.ok, true);
  assert.deepEqual(result.ok ? result.value : null, {
    externalUserId: "ext-2",
    email: null,
    hasEmail: false,
    status: "inactive",
    hasStatus: true,
  });
});

test("parseDeleteAppUserInput requires externalUserId", () => {
  const result = parseDeleteAppUserInput(null);
  assert.equal(result.ok, false);
  assert.equal(result.ok ? "" : result.error, "externalUserId is required");
});
