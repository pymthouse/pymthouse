import test from "node:test";
import assert from "node:assert/strict";

import {
  buildAppCapabilityFeatureKey,
  buildCapabilityFeatureKey,
  buildCapabilityMeterGroupByFilters,
  resolveCapabilityFeatureKey,
  validateCapabilityFeatureKeys,
} from "./capability-features";
import { billingStableFeatureKeysEnabled } from "@/lib/billing/feature-flags";
import { OPENMETER_SLUG_KEY_PATTERN } from "./slug-keys";

test("buildCapabilityFeatureKey matches OpenMeter slug pattern", () => {
  const key = buildCapabilityFeatureKey({
    clientId: "app_51803fb3e53dce667cf0e4df",
    planId: "8c940aad-455e-4bf0-b3a5-6fc3759451d6",
    pipeline: "live-video-to-video",
    modelId: "stabilityai/sdxl",
  });
  assert.match(key, OPENMETER_SLUG_KEY_PATTERN);
});

test("buildAppCapabilityFeatureKey matches OpenMeter slug pattern", () => {
  const key = buildAppCapabilityFeatureKey({
    clientId: "app_51803fb3e53dce667cf0e4df",
    pipeline: "live-video-to-video",
    modelId: "*",
  });
  assert.match(key, OPENMETER_SLUG_KEY_PATTERN);
});

test("resolveCapabilityFeatureKey uses app-scoped key when stable keys enabled", () => {
  if (!billingStableFeatureKeysEnabled()) {
    return;
  }
  assert.equal(
    resolveCapabilityFeatureKey({
      clientId: "app_1",
      planId: "plan-1",
      pipeline: "text-to-image",
      modelId: "*",
    }),
    buildAppCapabilityFeatureKey({
      clientId: "app_1",
      pipeline: "text-to-image",
      modelId: "*",
    }),
  );
});

test("validateCapabilityFeatureKeys accepts typical capability rows", () => {
  const result = validateCapabilityFeatureKeys({
    clientId: "app_51803fb3e53dce667cf0e4df",
    planId: "8c940aad-455e-4bf0-b3a5-6fc3759451d6",
    capabilities: [{ pipeline: "live-video-to-video", modelId: "*" }],
  });
  assert.equal(result.ok, true);
});

test("buildCapabilityMeterGroupByFilters omits model for wildcard", () => {
  assert.deepEqual(
    buildCapabilityMeterGroupByFilters({ pipeline: "text-to-image", modelId: "*" }),
    { pipeline: { $eq: "text-to-image" } },
  );
  assert.deepEqual(
    buildCapabilityMeterGroupByFilters({
      pipeline: "text-to-image",
      modelId: "stabilityai/sdxl",
    }),
    {
      pipeline: { $eq: "text-to-image" },
      model_id: { $eq: "stabilityai/sdxl" },
    },
  );
});
