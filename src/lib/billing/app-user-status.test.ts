import assert from "node:assert/strict";
import { test } from "node:test";

import {
  isAppUserStatus,
  parseAppUserStatus,
} from "@/lib/billing/app-user-status";

test("isAppUserStatus accepts only active and inactive", () => {
  assert.equal(isAppUserStatus("active"), true);
  assert.equal(isAppUserStatus("inactive"), true);
  assert.equal(isAppUserStatus("suspended"), false);
  assert.equal(isAppUserStatus(""), false);
  assert.equal(isAppUserStatus(null), false);
});

test("parseAppUserStatus normalizes case and rejects unknown values", () => {
  assert.deepEqual(parseAppUserStatus("Active"), {
    ok: true,
    status: "active",
  });
  assert.deepEqual(parseAppUserStatus(" INACTIVE "), {
    ok: true,
    status: "inactive",
  });
  const bad = parseAppUserStatus("suspended");
  assert.equal(bad.ok, false);
  if (!bad.ok) {
    assert.match(bad.error, /active, inactive/);
  }
});
