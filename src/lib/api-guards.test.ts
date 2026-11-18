import assert from "node:assert/strict";
import test from "node:test";

import { authorizeSessionRole } from "@/lib/api-guards";

const adminOnly = ["admin"] as const;

test("authorizeSessionRole allows the current database role", () => {
  assert.equal(
    authorizeSessionRole({ dbRole: "admin", allowedRoles: adminOnly }),
    "ok",
  );
});

test("authorizeSessionRole rejects a demoted account even if the JWT still says admin", () => {
  assert.equal(
    authorizeSessionRole({ dbRole: "developer", allowedRoles: adminOnly }),
    "forbidden",
  );
});

test("authorizeSessionRole rejects a deleted account", () => {
  assert.equal(
    authorizeSessionRole({ dbRole: null, allowedRoles: adminOnly }),
    "unauthorized",
  );
});
