import assert from "node:assert/strict";
import test from "node:test";

import { merchantOwnerWireTargetError } from "@/lib/billing/wallet-billing-target";

test("merchant wallet target rejects owner: wire subjects", () => {
  const result = merchantOwnerWireTargetError("owner:victim-user");
  assert.equal(result?.ok, false);
  if (result) {
    assert.equal(result.status, 400);
    assert.match(result.error, /owner:\{users\.id\}/);
  }
});

test("merchant wallet target accepts ordinary end-user ids", () => {
  assert.equal(merchantOwnerWireTargetError("eu_end_user"), null);
  assert.equal(merchantOwnerWireTargetError("ext-123"), null);
});
