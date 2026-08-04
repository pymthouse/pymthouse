import assert from "node:assert/strict";
import test from "node:test";

import { ownerPaidUpgradeHttpStatus } from "@/lib/openmeter/owner-paid-upgrade-status";

test("ownerPaidUpgradeHttpStatus maps known codes", () => {
  assert.equal(ownerPaidUpgradeHttpStatus("payment_method_required"), 402);
  assert.equal(ownerPaidUpgradeHttpStatus("openmeter_unavailable"), 503);
  assert.equal(ownerPaidUpgradeHttpStatus("no_subscription"), 404);
  assert.equal(ownerPaidUpgradeHttpStatus("upgrade_failed"), 400);
});
