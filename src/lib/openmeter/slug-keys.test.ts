import test from "node:test";
import assert from "node:assert/strict";

import {
  OPENMETER_SLUG_KEY_PATTERN,
  buildAppCapabilityFeatureKey,
} from "./capability-features";
import { buildOpenMeterPlanKey, buildOpenMeterRateCardKey } from "./plan-naming";
import { isValidOpenMeterSlugKey, toOpenMeterSlugKey } from "./slug-keys";

test("toOpenMeterSlugKey matches OpenMeter slug pattern", () => {
  const key = toOpenMeterSlugKey("app", "live-video-to-video", "all");
  assert.match(key, OPENMETER_SLUG_KEY_PATTERN);
});

test("buildAppCapabilityFeatureKey has no colons or uppercase", () => {
  const key = buildAppCapabilityFeatureKey({
    clientId: "app_51803fb3e53dce667cf0e4df",
    pipeline: "live-video-to-video",
    modelId: "*",
  });
  assert.match(key, OPENMETER_SLUG_KEY_PATTERN);
  assert.ok(!key.includes(":"));
  assert.equal(key, key.toLowerCase());
});

test("buildOpenMeterPlanKey matches slug pattern", () => {
  const key = buildOpenMeterPlanKey(
    "app_51803fb3e53dce667cf0e4df",
    "8c940aad-455e-4bf0-b3a5-6fc3759451d6",
  );
  assert.ok(isValidOpenMeterSlugKey(key));
});

test("buildOpenMeterRateCardKey matches slug pattern", () => {
  const key = buildOpenMeterRateCardKey({
    pipeline: "live-video-to-video",
    modelId: "*",
  });
  assert.match(key, /^usage_live_video_to_video_all$/);
  assert.ok(isValidOpenMeterSlugKey(key));
});

test("toOpenMeterSlugKey handles long underscore runs without hanging", () => {
  const key = toOpenMeterSlugKey(`app_${"_".repeat(10_000)}live`);
  assert.ok(isValidOpenMeterSlugKey(key));
});
