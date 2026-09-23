import assert from "node:assert/strict";
import test from "node:test";

import { parseAdminReviewInput } from "./admin-apps";

test("parseAdminReviewInput validates action", () => {
  const result = parseAdminReviewInput({ action: "nope" });
  assert.equal(result.ok, false);
  assert.equal(result.ok ? "" : result.body.error, "action must be 'approve' or 'reject'");
});

test("parseAdminReviewInput reads notes", () => {
  const result = parseAdminReviewInput({ action: "approve", notes: "ok" });
  assert.equal(result.ok, true);
  assert.deepEqual(result.ok ? result.value : null, { action: "approve", notes: "ok" });
});
