import assert from "node:assert/strict";
import test from "node:test";

import {
  formatModelAttributionLabel,
  LIVE_VIDEO_TO_VIDEO_PIPELINE,
  resolveSignedTicketAppAttribution,
} from "./signed-ticket-attribution";

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
