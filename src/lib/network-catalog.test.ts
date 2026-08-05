import assert from "node:assert/strict";
import { test } from "node:test";

import { catalogFromDiscoveryRaw, splitCapability } from "./network-catalog";

test("splitCapability: pipeline/model", () => {
  assert.deepEqual(splitCapability("transcode/ffmpeg"), {
    pipeline: "transcode",
    model: "ffmpeg",
  });
});

test("splitCapability: bare capability uses same id for pipeline and model", () => {
  assert.deepEqual(splitCapability("streamdiffusion-sdxl"), {
    pipeline: "streamdiffusion-sdxl",
    model: "streamdiffusion-sdxl",
  });
});

test("catalogFromDiscoveryRaw aggregates capabilities across orchestrators", () => {
  const catalog = catalogFromDiscoveryRaw([
    {
      address: "https://a.example",
      capabilities: ["streamdiffusion-sdxl", "transcode/ffmpeg"],
    },
    {
      address: "https://b.example",
      capabilities: ["streamdiffusion-sdxl", "streamdiffusion-sdxl-v2v"],
    },
    {
      address: "https://c.example",
      capabilities: ["livepeer-example/hello-world"],
    },
  ]);

  assert.deepEqual(catalog, [
    {
      id: "livepeer-example",
      name: "livepeer-example",
      models: ["hello-world"],
    },
    {
      id: "streamdiffusion-sdxl",
      name: "streamdiffusion-sdxl",
      models: ["streamdiffusion-sdxl"],
    },
    {
      id: "streamdiffusion-sdxl-v2v",
      name: "streamdiffusion-sdxl-v2v",
      models: ["streamdiffusion-sdxl-v2v"],
    },
    {
      id: "transcode",
      name: "transcode",
      models: ["ffmpeg"],
    },
  ]);
});

test("catalogFromDiscoveryRaw rejects non-array", () => {
  assert.throws(() => catalogFromDiscoveryRaw({}), /not an array/);
});
