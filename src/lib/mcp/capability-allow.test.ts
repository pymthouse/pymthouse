import assert from "node:assert/strict";
import test from "node:test";

import {
  canonicalizeCapability,
  capabilityAllowKeys,
  filterAllowedCapabilities,
  isCapabilityAllowed,
  isCapabilityExcluded,
  partitionByExclusions,
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

test("capabilityAllowKeys emits the canonical slash and bare-token forms", () => {
  const keys = capabilityAllowKeys([
    { pipeline: "livepeer-example", modelId: "hello-world" },
    // Bare wire token: splitCapability yields pipeline === model.
    { pipeline: "streamdiffusion-sdxl", modelId: "streamdiffusion-sdxl" },
    { pipeline: "live-runner", modelId: "*" },
  ]);
  assert.equal(keys.has("livepeer-example/hello-world"), true);
  assert.equal(keys.has("streamdiffusion-sdxl"), true);
  assert.equal(keys.has("live-runner/*"), true);
  // A bare key is only emitted when pipeline === modelId.
  assert.equal(keys.has("livepeer-example"), false);
  assert.equal(keys.has("live-runner"), false);
});

test("isCapabilityAllowed accepts the canonical pipeline/model wire form", () => {
  const allow = capabilityAllowKeys([
    { pipeline: "livepeer-example", modelId: "hello-world" },
    { pipeline: "transcode", modelId: "ffmpeg" },
  ]);
  assert.equal(isCapabilityAllowed("livepeer-example/hello-world", allow), true);
  assert.equal(isCapabilityAllowed("transcode/ffmpeg", allow), true);
  assert.equal(isCapabilityAllowed("  transcode/ffmpeg  ", allow), true);
  assert.equal(isCapabilityAllowed("transcode/av1", allow), false);
  assert.equal(isCapabilityAllowed("other/ffmpeg", allow), false);
});

test("isCapabilityAllowed accepts bare-token capabilities", () => {
  const allow = capabilityAllowKeys([
    { pipeline: "streamdiffusion-sdxl", modelId: "streamdiffusion-sdxl" },
  ]);
  assert.equal(isCapabilityAllowed("streamdiffusion-sdxl", allow), true);
  // Legacy spellings of the same entry still resolve.
  assert.equal(
    isCapabilityAllowed("streamdiffusion-sdxl/streamdiffusion-sdxl", allow),
    true,
  );
  assert.equal(isCapabilityAllowed("streamdiffusion-xl", allow), false);
});

test("isCapabilityAllowed matches wildcard across every separator", () => {
  const allow = capabilityAllowKeys([{ pipeline: "live-runner", modelId: "*" }]);
  assert.equal(isCapabilityAllowed("live-runner/anything", allow), true);
  assert.equal(isCapabilityAllowed("live-runner|anything", allow), true);
  assert.equal(isCapabilityAllowed("live-runner:anything", allow), true);
  assert.equal(isCapabilityAllowed("live-runner", allow), true);
  assert.equal(isCapabilityAllowed("live-runner/nested/model", allow), true);
  assert.equal(isCapabilityAllowed("live-runner-x/anything", allow), false);
  assert.equal(isCapabilityAllowed("other/anything", allow), false);
});

test("isCapabilityAllowed does not mangle colons inside capability names", () => {
  const allow = capabilityAllowKeys([
    // Bare wire token containing a colon.
    {
      pipeline: "openai:images.generations",
      modelId: "openai:images.generations",
    },
    // Colons in both halves of a structured entry.
    { pipeline: "video:transcode", modelId: "h264:high" },
  ]);
  assert.equal(isCapabilityAllowed("openai:images.generations", allow), true);
  assert.equal(isCapabilityAllowed("video:transcode/h264:high", allow), true);
  assert.equal(isCapabilityAllowed("video:transcode|h264:high", allow), true);
  // Regression: the old `.replace(":", "|")` split on the FIRST colon and failed.
  assert.equal(isCapabilityAllowed("video:transcode:h264:high", allow), true);
  // No pipeline "openai" / "video" is ever derived without a wildcard row.
  assert.equal(isCapabilityAllowed("openai:audio.speech", allow), false);
  assert.equal(isCapabilityAllowed("openai", allow), false);
  assert.equal(isCapabilityAllowed("video:transcode", allow), false);
});

test("filterAllowedCapabilities returns the caller's original strings", () => {
  const manifest = [
    { pipeline: "livepeer-example", modelId: "hello-world" },
    { pipeline: "streamdiffusion-sdxl", modelId: "streamdiffusion-sdxl" },
  ];
  const requested = [
    "livepeer-example/hello-world",
    "livepeer-example|hello-world",
    "streamdiffusion-sdxl",
    "not-allowed/model",
  ];
  const filtered = filterAllowedCapabilities(requested, manifest);
  // Spelling is preserved exactly: QueryResponse.results is keyed by the
  // request string, so filtering must never rewrite.
  assert.deepEqual(filtered, [
    "livepeer-example/hello-world",
    "livepeer-example|hello-world",
    "streamdiffusion-sdxl",
  ]);
  for (const capability of filtered) {
    assert.equal(requested.includes(capability), true);
  }
  // Surrounding whitespace is trimmed for matching only, not in the output.
  assert.deepEqual(
    filterAllowedCapabilities(
      ["  transcode/ffmpeg  "],
      [{ pipeline: "transcode", modelId: "ffmpeg" }],
    ),
    ["  transcode/ffmpeg  "],
  );
  // hosted-server derives dropped_capabilities by identity against the input.
  assert.deepEqual(
    requested.filter((c) => !filtered.includes(c)),
    ["not-allowed/model"],
  );
});

test("canonicalizeCapability splits canonically and keeps legacy candidates", () => {
  assert.deepEqual(canonicalizeCapability("  transcode/ffmpeg  "), {
    raw: "transcode/ffmpeg",
    pipeline: "transcode",
    modelId: "ffmpeg",
    pipelineCandidates: ["transcode"],
  });
  assert.deepEqual(canonicalizeCapability("streamdiffusion-sdxl"), {
    raw: "streamdiffusion-sdxl",
    pipeline: "streamdiffusion-sdxl",
    modelId: "streamdiffusion-sdxl",
    pipelineCandidates: ["streamdiffusion-sdxl"],
  });
  assert.deepEqual(
    canonicalizeCapability("live-runner:anything")?.pipelineCandidates,
    ["live-runner:anything", "live-runner"],
  );
  assert.equal(canonicalizeCapability("   "), null);
  assert.equal(canonicalizeCapability(""), null);
});

test("partitionByExclusions permits everything when nothing is excluded", () => {
  const requested = [
    "streamdiffusion-sdxl",
    "livepeer-example/flux-klein",
    "some-brand-new/capability",
  ];
  assert.deepEqual(partitionByExclusions(requested, []), {
    permitted: requested,
    excluded: [],
  });
});

test("partitionByExclusions permits capabilities absent from the catalog", () => {
  // Regression: orchestrators advertise `streamdiffusion-sdxl` bare while the
  // catalog spells it `live-video-to-video/streamdiffusion-sdxl`. A catalog gap
  // is not a denial.
  const { permitted, excluded } = partitionByExclusions(
    ["streamdiffusion-sdxl"],
    [{ pipeline: "transcode", modelId: "ffmpeg" }],
  );
  assert.deepEqual(permitted, ["streamdiffusion-sdxl"]);
  assert.deepEqual(excluded, []);
});

test("partitionByExclusions blocks explicitly excluded capabilities", () => {
  const { permitted, excluded } = partitionByExclusions(
    ["transcode/ffmpeg", "livepeer-example/hello-world"],
    [{ pipeline: "transcode", modelId: "ffmpeg" }],
  );
  assert.deepEqual(permitted, ["livepeer-example/hello-world"]);
  assert.deepEqual(excluded, ["transcode/ffmpeg"]);
});

test("partitionByExclusions catches legacy spellings and wildcards", () => {
  const excludedManifest = [
    { pipeline: "transcode", modelId: "ffmpeg" },
    { pipeline: "vllm", modelId: "*" },
  ];
  const { permitted, excluded } = partitionByExclusions(
    [
      "transcode|ffmpeg",
      "transcode:ffmpeg",
      "vllm/qwen3-coder-30b",
      "livepeer-example/hello-world",
    ],
    excludedManifest,
  );
  assert.deepEqual(permitted, ["livepeer-example/hello-world"]);
  assert.deepEqual(excluded, [
    "transcode|ffmpeg",
    "transcode:ffmpeg",
    "vllm/qwen3-coder-30b",
  ]);
});

test("partitionByExclusions returns the caller's original strings", () => {
  const { permitted } = partitionByExclusions(
    ["  livepeer-example/hello-world  "],
    [{ pipeline: "transcode", modelId: "ffmpeg" }],
  );
  assert.deepEqual(permitted, ["  livepeer-example/hello-world  "]);
});

test("isCapabilityExcluded matches the same spellings as the allow side", () => {
  const deny = capabilityAllowKeys([{ pipeline: "transcode", modelId: "ffmpeg" }]);
  assert.equal(isCapabilityExcluded("transcode/ffmpeg", deny), true);
  assert.equal(isCapabilityExcluded("transcode|ffmpeg", deny), true);
  assert.equal(isCapabilityExcluded("transcode/av1", deny), false);
  assert.equal(isCapabilityExcluded("   ", deny), false);
});
