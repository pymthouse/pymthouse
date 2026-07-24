import assert from "node:assert/strict";
import test from "node:test";

import {
  capabilityAllowKeys,
  filterAllowedCapabilities,
  isCapabilityAllowed,
} from "@/lib/mcp/capability-allow";

test("capabilityAllowKeys emits pipe and colon forms", () => {
  const keys = capabilityAllowKeys([
    { pipeline: "text-to-image", modelId: "sdxl" },
    { pipeline: "live-runner", modelId: "*" },
  ]);
  assert.equal(keys.has("text-to-image|sdxl"), true);
  assert.equal(keys.has("text-to-image:sdxl"), true);
  assert.equal(keys.has("live-runner|*"), true);
  assert.equal(keys.has("live-runner:*"), true);
});

test("isCapabilityAllowed matches exact, colon, and wildcard", () => {
  const allow = capabilityAllowKeys([
    { pipeline: "text-to-image", modelId: "sdxl" },
    { pipeline: "live-runner", modelId: "*" },
  ]);
  assert.equal(isCapabilityAllowed("text-to-image|sdxl", allow), true);
  assert.equal(isCapabilityAllowed("text-to-image:sdxl", allow), true);
  assert.equal(isCapabilityAllowed("live-runner:anything", allow), true);
  assert.equal(isCapabilityAllowed("batch:other", allow), false);
  assert.equal(isCapabilityAllowed("  ", allow), false);
});

test("filterAllowedCapabilities drops disallowed requests", () => {
  const filtered = filterAllowedCapabilities(
    ["text-to-image:sdxl", "batch:x"],
    [{ pipeline: "text-to-image", modelId: "sdxl" }],
  );
  assert.deepEqual(filtered, ["text-to-image:sdxl"]);
});
