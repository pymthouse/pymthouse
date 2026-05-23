import assert from "node:assert/strict";
import test from "node:test";

import {
  assertCapabilityRowsDiscoverable,
  expandCapabilityRowsToConcreteKeys,
  getDiscoverableConcreteKeys,
} from "./network-default-plan";
import { planDisplayName } from "./network-default-plan-display";
import { normalizeDiscoveryAllowlistDoc } from "./discovery-allowlist";

const CATALOG = [
  { id: "pipe-a", models: ["m1", "m2"] },
  { id: "pipe-b", models: ["only"] },
];

test("getDiscoverableConcreteKeys subtracts exclusions", () => {
  const ex = normalizeDiscoveryAllowlistDoc({
    capabilities: [{ pipeline: "pipe-a", modelId: "m1" }],
  });
  const keys = getDiscoverableConcreteKeys(CATALOG, ex!);
  assert.deepEqual([...keys].sort(), ["pipe-a|m2", "pipe-b|only"]);
});

test("expandCapabilityRowsToConcreteKeys expands wildcard", () => {
  const keys = expandCapabilityRowsToConcreteKeys(CATALOG, [
    { pipeline: "pipe-a", modelId: "*" },
  ]);
  assert.deepEqual([...keys].sort(), ["pipe-a|m1", "pipe-a|m2"]);
});

test("assertCapabilityRowsDiscoverable detects blocked models", () => {
  const discoverable = new Set(["pipe-a|m2", "pipe-b|only"]);
  const r = assertCapabilityRowsDiscoverable(CATALOG, discoverable, [
    { pipeline: "pipe-a", modelId: "m1" },
  ]);
  assert.equal(r.ok, false);
  if (!r.ok) {
    assert.ok(r.conflicts.some((c) => c.pipeline === "pipe-a" && c.modelId === "m1"));
  }
});

test("planDisplayName maps internal network default name", () => {
  assert.equal(
    planDisplayName({ name: "__pymthouse_network_default__", isNetworkDefault: true }),
    "Network Discovery",
  );
  assert.equal(planDisplayName({ name: "Foo", isNetworkDefault: false }), "Foo");
});
