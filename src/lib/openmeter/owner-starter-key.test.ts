import assert from "node:assert/strict";
import test from "node:test";

import {
  isBaseOwnerStarterPlanKey,
  ownerStarterPlanKeyForAmount,
} from "@/lib/openmeter/owner-starter-key";

test("ownerStarterPlanKeyForAmount uses the passed platform default", () => {
  assert.equal(
    ownerStarterPlanKeyForAmount("10000000", "10000000"),
    "pymthouse_owner_starter",
  );
  assert.equal(
    ownerStarterPlanKeyForAmount("5000000", "10000000"),
    "pymthouse_owner_starter_5000000",
  );
});

test("isBaseOwnerStarterPlanKey matches only the shared key", () => {
  assert.equal(isBaseOwnerStarterPlanKey("pymthouse_owner_starter"), true);
  assert.equal(isBaseOwnerStarterPlanKey("pymthouse_owner_starter_5000000"), false);
  assert.equal(isBaseOwnerStarterPlanKey(null), false);
});
