import test from "node:test";
import assert from "node:assert/strict";

import {
  buildOpenMeterPlanKey,
  buildOpenMeterRateCardKey,
  normalizeCustomPlanName,
  validateCustomPlanName,
} from "./plan-naming";
import { isValidOpenMeterSlugKey } from "./slug-keys";

test("validateCustomPlanName accepts PPU lv2v style names", () => {
  const result = validateCustomPlanName("PPU - lv2v");
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.value, "PPU - lv2v");
  }
});

test("validateCustomPlanName rejects special characters", () => {
  const result = validateCustomPlanName("Plan (100%)");
  assert.equal(result.ok, false);
});

test("normalizeCustomPlanName strips invalid characters", () => {
  assert.equal(normalizeCustomPlanName("PPU – lv2v"), "PPU lv2v");
  assert.equal(normalizeCustomPlanName("Plan (100%)"), "Plan 100");
});

test("buildOpenMeterPlanKey fits OpenMeter slug rules", () => {
  const key = buildOpenMeterPlanKey(
    "app_51803fb3e53dce667cf0e4df",
    "8c940aad-455e-4bf0-b3a5-6fc3759451d6",
  );
  assert.ok(isValidOpenMeterSlugKey(key));
});

test("buildOpenMeterRateCardKey fits OpenMeter slug rules", () => {
  const key = buildOpenMeterRateCardKey({
    pipeline: "live-video-to-video",
    modelId: "*",
  });
  assert.ok(isValidOpenMeterSlugKey(key));
  assert.match(key, /^usage_live_video_to_video_all$/);
});
