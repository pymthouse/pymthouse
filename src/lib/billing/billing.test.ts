import test from "node:test";
import assert from "node:assert/strict";

import {
  applyRetailRateToNetworkMicros,
  markupPercentToRetailRateUsd,
} from "@pymthouse/builder-sdk";
import { resolveEffectiveRetailRateUsd } from "./retail-estimate";
import { deriveSyncState, toCapabilityPriceRule } from "./product-dto";
import { billingStableFeatureKeysEnabled } from "./feature-flags";
import {
  buildAppCapabilityFeatureKey,
  resolveCapabilityFeatureKey,
} from "@/lib/openmeter/capability-features";

test("1000% markup retail rate is 11x network pass-through", () => {
  assert.equal(markupPercentToRetailRateUsd(1000), "0.000011");
  const network = 148854n;
  const retail = applyRetailRateToNetworkMicros(network, "0.000011");
  assert.equal(retail, 1637394n);
});

test("resolveEffectiveRetailRateUsd prefers capability override", () => {
  assert.equal(
    resolveEffectiveRetailRateUsd({
      capabilityRetailRateUsd: "0.000011",
      planOverageRateUsd: "0.000001",
    }),
    "0.000011",
  );
});

test("deriveSyncState maps pending when active plan has no OM id", () => {
  const sync = deriveSyncState({
    id: "p1",
    type: "usage",
    isNetworkDefault: false,
    openmeterPlanId: null,
    lastSyncedAt: null,
    syncError: null,
    openmeterPlanVersion: null,
  } as never);
  assert.equal(sync.status, "pending");
});

test("stable feature keys when flag enabled", () => {
  if (!billingStableFeatureKeysEnabled()) {
    return;
  }
  const key = resolveCapabilityFeatureKey({
    clientId: "app_1",
    planId: "plan-1",
    pipeline: "live-video-to-video",
    modelId: "*",
  });
  const expected = buildAppCapabilityFeatureKey({
    clientId: "app_1",
    pipeline: "live-video-to-video",
    modelId: "*",
  });
  assert.equal(key, expected);
  assert.match(key, /^[a-z0-9]+(?:_[a-z0-9]+)*$/);
  assert.ok(!key.includes("plan-1"));
});

test("toCapabilityPriceRule exposes markup percent", () => {
  const rule = toCapabilityPriceRule({
    clientId: "app_1",
    plan: {
      overageRateUsd: "0.000001",
    } as never,
    capability: {
      pipeline: "live-video-to-video",
      modelId: "*",
      retailRateUsd: "0.000011",
    } as never,
  });
  assert.equal(rule.markupPercent, "1000");
  assert.equal(rule.effectiveRetailRateUsd, "0.000011");
});
