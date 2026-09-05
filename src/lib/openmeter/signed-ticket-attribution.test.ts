import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  formatModelAttributionLabel,
  LIVE_VIDEO_TO_VIDEO_PIPELINE,
  resolveSignedTicketAppAttribution,
} from "./signed-ticket-attribution";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "../../..");

test("resolveSignedTicketAppAttribution prefers signer app over pipeline and model_id", () => {
  assert.equal(
    resolveSignedTicketAppAttribution({
      app: "livepeer-example/hello-world",
      pipeline: "live",
      modelId: "unknown",
    }),
    "livepeer-example/hello-world",
  );
});

test("resolveSignedTicketAppAttribution uses live-video-to-video pipeline when app is empty", () => {
  assert.equal(
    resolveSignedTicketAppAttribution({
      app: "",
      pipeline: LIVE_VIDEO_TO_VIDEO_PIPELINE,
      modelId: "unknown",
    }),
    LIVE_VIDEO_TO_VIDEO_PIPELINE,
  );
  assert.equal(
    resolveSignedTicketAppAttribution({
      app: "unknown",
      pipeline: LIVE_VIDEO_TO_VIDEO_PIPELINE,
    }),
    LIVE_VIDEO_TO_VIDEO_PIPELINE,
  );
});

test("resolveSignedTicketAppAttribution treats Unknown as missing", () => {
  assert.equal(
    resolveSignedTicketAppAttribution({
      app: "Unknown",
      pipeline: LIVE_VIDEO_TO_VIDEO_PIPELINE,
    }),
    LIVE_VIDEO_TO_VIDEO_PIPELINE,
  );
});

test("resolveSignedTicketAppAttribution does not substitute other pipelines for empty app", () => {
  assert.equal(
    resolveSignedTicketAppAttribution({
      app: "",
      pipeline: "live",
      modelId: "unknown",
    }),
    "unknown",
  );
});

test("resolveSignedTicketAppAttribution keeps historical model_id when app is empty", () => {
  assert.equal(
    resolveSignedTicketAppAttribution({
      app: "",
      pipeline: "text-to-image",
      modelId: "sdxl",
    }),
    "sdxl",
  );
  assert.equal(
    resolveSignedTicketAppAttribution({
      app: "unknown",
      pipeline: LIVE_VIDEO_TO_VIDEO_PIPELINE,
      modelId: "streamdiffusion-sdxl",
    }),
    "streamdiffusion-sdxl",
  );
});

test("formatModelAttributionLabel omits redundant live-video-to-video duplication", () => {
  assert.equal(
    formatModelAttributionLabel(LIVE_VIDEO_TO_VIDEO_PIPELINE, LIVE_VIDEO_TO_VIDEO_PIPELINE),
    LIVE_VIDEO_TO_VIDEO_PIPELINE,
  );
  assert.equal(
    formatModelAttributionLabel("live", "livepeer-example/hello-world"),
    "live / livepeer-example/hello-world",
  );
  assert.equal(formatModelAttributionLabel("live", "unknown"), "live");
});

test("collector CloudEvent dual-writes resolved app onto data.model_id", () => {
  const yaml = readFileSync(
    join(repoRoot, "deploy/openmeter-collector/collector.yaml"),
    "utf8",
  );
  assert.match(yaml, /"app": \$app_out/);
  assert.match(yaml, /"model_id": \$app_out/);
});

test("HTTP signed-ticket ingest dual-writes resolved app onto data.model_id", () => {
  const source = readFileSync(
    join(repoRoot, "src/lib/openmeter/entitlements.ts"),
    "utf8",
  );
  assert.match(source, /model_id:\s*app/);
});
