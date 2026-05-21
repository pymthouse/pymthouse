import assert from "node:assert/strict";
import test from "node:test";

import {
  mergeDiscoveryPolicies,
  parseDiscoveryPolicyInput,
} from "./discovery-plans";

test("parseDiscoveryPolicyInput accepts valid policy", () => {
  const r = parseDiscoveryPolicyInput(
    {
      topN: 10,
      sortBy: "price",
      slaMinScore: 0.5,
      filters: { gpuRamGbMin: 8, gpuRamGbMax: 48, priceMax: 1.5 },
    },
    "discoveryPolicy",
  );
  assert.equal(r.ok, true);
  assert.ok(r.ok && r.policy?.topN === 10);
  assert.ok(r.ok && r.policy?.filters?.gpuRamGbMin === 8);
});

test("parseDiscoveryPolicyInput rejects invalid sortBy", () => {
  const r = parseDiscoveryPolicyInput({ sortBy: "nope" }, "discoveryPolicy");
  assert.equal(r.ok, false);
});

test("parseDiscoveryPolicyInput rejects gpuRamGbMin > gpuRamGbMax", () => {
  const r = parseDiscoveryPolicyInput(
    { filters: { gpuRamGbMin: 64, gpuRamGbMax: 16 } },
    "discoveryPolicy",
  );
  assert.equal(r.ok, false);
});

test("mergeDiscoveryPolicies caps topN and intersects filters", () => {
  const merged = mergeDiscoveryPolicies(
    { topN: 10, filters: { priceMax: 100, gpuRamGbMin: 8 } },
    { topN: 50, filters: { priceMax: 50, gpuRamGbMin: 16 } },
  );
  assert.equal(merged?.topN, 10);
  assert.equal(merged?.filters?.priceMax, 50);
  assert.equal(merged?.filters?.gpuRamGbMin, 16);
});
