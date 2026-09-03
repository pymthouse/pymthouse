import assert from "node:assert/strict";
import test from "node:test";

import {
  capabilityFromUsageFields,
  formatUsageCapabilityLabel,
  isUnknownUsageCapability,
} from "./usage-capability";

test("capabilityFromUsageFields prefers app over empty or unknown model_id", () => {
  assert.equal(
    capabilityFromUsageFields({
      app: "live-video-to-video/scope",
      modelId: "unknown",
    }),
    "live-video-to-video/scope",
  );
  assert.equal(
    capabilityFromUsageFields({
      app: " flux-schnell ",
      modelId: "",
    }),
    "flux-schnell",
  );
  assert.equal(
    capabilityFromUsageFields({
      app: "",
      modelId: "sdxl",
    }),
    "sdxl",
  );
  assert.equal(capabilityFromUsageFields({}), "unknown");
});

test("isUnknownUsageCapability treats blank and unknown as missing", () => {
  assert.equal(isUnknownUsageCapability(null), true);
  assert.equal(isUnknownUsageCapability(""), true);
  assert.equal(isUnknownUsageCapability("unknown"), true);
  assert.equal(isUnknownUsageCapability("Unknown"), true);
  assert.equal(isUnknownUsageCapability("sdxl"), false);
});

test("formatUsageCapabilityLabel hides unknown model and keeps pipeline", () => {
  assert.equal(
    formatUsageCapabilityLabel("live-video-to-video", "unknown"),
    "live-video-to-video",
  );
  assert.equal(
    formatUsageCapabilityLabel("live-video-to-video", "live-video-to-video/scope"),
    "live-video-to-video / live-video-to-video/scope",
  );
});
