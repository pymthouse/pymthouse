import test from "node:test";
import assert from "node:assert/strict";

import {
  buildAppCapabilityFeatureKey,
  buildCapabilityFeatureKey,
  buildCapabilityMeterGroupByFilters,
  capabilityWireAppAttribution,
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

test("resolveCapabilityFeatureKey uses app-scoped key when stable keys enabled", (t) => {
  if (!billingStableFeatureKeysEnabled()) {
    t.skip("billing stable feature keys disabled");
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

test("capabilityWireAppAttribution matches ingest data.app", () => {
  assert.equal(
    capabilityWireAppAttribution({
      pipeline: "livepeer-example",
      modelId: "hello-world",
    }),
    "livepeer-example/hello-world",
  );
  assert.equal(
    capabilityWireAppAttribution({
      pipeline: "live-video-to-video",
      modelId: "scope",
    }),
    "live-video-to-video/scope",
  );
  assert.equal(
    capabilityWireAppAttribution({
      pipeline: "streamdiffusion-sdxl",
      modelId: "streamdiffusion-sdxl",
    }),
    "streamdiffusion-sdxl",
  );
  assert.equal(
    capabilityWireAppAttribution({
      pipeline: "text-to-image",
      modelId: "stabilityai/sdxl",
    }),
    "text-to-image/stabilityai/sdxl",
  );
});

test("buildCapabilityMeterGroupByFilters uses wire app, omits for wildcard", () => {
  assert.deepEqual(
    buildCapabilityMeterGroupByFilters({ pipeline: "text-to-image", modelId: "*" }),
    { pipeline: { $eq: "text-to-image" } },
  );
  assert.deepEqual(
    buildCapabilityMeterGroupByFilters({
      pipeline: "livepeer-example",
      modelId: "hello-world",
    }),
    {
      pipeline: { $eq: "livepeer-example" },
      app: { $eq: "livepeer-example/hello-world" },
    },
  );
  assert.deepEqual(
    buildCapabilityMeterGroupByFilters({
      pipeline: "streamdiffusion-sdxl",
      modelId: "streamdiffusion-sdxl",
    }),
    {
      pipeline: { $eq: "streamdiffusion-sdxl" },
      app: { $eq: "streamdiffusion-sdxl" },
    },
  );
});
