import test from "node:test";
import assert from "node:assert/strict";

import {
  FORBIDDEN_INTERNAL_FIELD_NAMES,
  assertNoLeakedInternalFieldNames,
  findLeakedInternalFieldNames,
} from "./forbidden-fields";

test("the forbidden list mirrors the C0 provider-internal-openmeter contract", () => {
  // Keep in sync with contracts/billing-provider-protocol/provider-internal-openmeter.schema.json
  const expected = [
    "openmeter_subscription_id",
    "openmeter_customer_id",
    "network_fee_usd_nanos",
    "fee_wei",
    "eth_usd_price",
    "eth_usd_round_id",
    "eth_usd_observed_at",
    "external_user_id",
    "client_id",
    "model_id",
    "gateway_request_id",
    "specversion",
  ];
  const byName = (a: string, b: string) => a.localeCompare(b);
  assert.deepEqual(
    [...FORBIDDEN_INTERNAL_FIELD_NAMES].sort(byName),
    [...expected].sort(byName),
  );
});

test("findLeakedInternalFieldNames detects nested provider-internal keys", () => {
  const leaked = findLeakedInternalFieldNames({
    valid: true,
    data: { nested: [{ openmeter_subscription_id: "01J..." }] },
  });
  assert.deepEqual(leaked, ["openmeter_subscription_id"]);
});

test("findLeakedInternalFieldNames ignores neutral string values", () => {
  // A capability id value that contains a model name is fine — only KEYS matter.
  const leaked = findLeakedInternalFieldNames({
    byCapability: { "text-to-image:model_id-lookalike": { tickets: 1 } },
  });
  assert.deepEqual(leaked, []);
});

test("assertNoLeakedInternalFieldNames throws on a leak and passes when clean", () => {
  assert.throws(
    () => assertNoLeakedInternalFieldNames({ fee_wei: "1" }, "test"),
    /seam isolation violation \(test\)/,
  );
  assert.doesNotThrow(() =>
    assertNoLeakedInternalFieldNames({ providerSlug: "pymthouse" }, "test"),
  );
});
