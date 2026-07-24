import test from "node:test";
import assert from "node:assert/strict";

import { endUserSubjectOverrideError } from "@/lib/auth/end-user";

test("endUserSubjectOverrideError rejects userId and externalUserId", () => {
  for (const key of ["userId", "externalUserId", "external_user_id"]) {
    const params = new URLSearchParams({ [key]: "someone-else" });
    const res = endUserSubjectOverrideError(params, "usage");
    assert.ok(res);
    assert.equal(res.status, 400);
  }
  assert.equal(endUserSubjectOverrideError(new URLSearchParams(), "usage"), null);
});
