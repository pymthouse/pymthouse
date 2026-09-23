import assert from "node:assert/strict";
import test from "node:test";

import { parseCreateAppAdminInput, parseDeleteAppAdminInput } from "./app-admins";

test("parseCreateAppAdminInput requires userId", () => {
  const parsed = parseCreateAppAdminInput({});
  assert.equal(parsed.ok, false);
  assert.equal(parsed.ok ? "" : parsed.error, "userId is required");
});

test("parseCreateAppAdminInput defaults role to admin", () => {
  const parsed = parseCreateAppAdminInput({ userId: "user-1" });
  assert.equal(parsed.ok, true);
  assert.ok(parsed.ok);
  assert.equal(parsed.value.userId, "user-1");
  assert.equal(parsed.value.role, "admin");
});

test("parseDeleteAppAdminInput requires userId", () => {
  const parsed = parseDeleteAppAdminInput(null);
  assert.equal(parsed.ok, false);
  assert.equal(parsed.ok ? "" : parsed.error, "userId is required");
});
