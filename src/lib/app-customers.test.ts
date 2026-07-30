import assert from "node:assert/strict";
import test from "node:test";

import { buildOpenMeterCustomerKey } from "@/lib/openmeter/customer-key";
import { matchUsageRowForExternalUser } from "@/lib/app-customers";

test("matchUsageRowForExternalUser matches bare external user id", () => {
  const usage = new Map([
    ["user-1", { requestCount: 3, networkFeeUsdMicros: "1000" }],
  ]);
  const hit = matchUsageRowForExternalUser(usage, "app_abc", "user-1");
  assert.deepEqual(hit, { requestCount: 3, networkFeeUsdMicros: "1000" });
});

test("matchUsageRowForExternalUser matches compound customer key", () => {
  const clientId = "app_98575870d7ae33589a3f0660";
  const externalUserId = "a80a7b4e-8ea0-41e3-9ec3-5829656badff";
  const compound = buildOpenMeterCustomerKey(clientId, externalUserId);
  const usage = new Map([
    [compound, { requestCount: 12, networkFeeUsdMicros: "5053000" }],
  ]);
  const hit = matchUsageRowForExternalUser(usage, clientId, externalUserId);
  assert.deepEqual(hit, { requestCount: 12, networkFeeUsdMicros: "5053000" });
});

test("matchUsageRowForExternalUser returns undefined when missing", () => {
  const usage = new Map([
    ["other", { requestCount: 1, networkFeeUsdMicros: "1" }],
  ]);
  assert.equal(
    matchUsageRowForExternalUser(usage, "app_abc", "missing"),
    undefined,
  );
});
